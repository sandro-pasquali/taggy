'use strict';

let util = require('util');
let Promise = require('bluebird');
let _ = require('lodash');
let debug = require('debug')('autocomplete');
let mh3 = require('./murmurhash3');

module.exports = (client, opts) => {

    opts = opts || {};

    let api = {};
    let completeMaxItems = _.isUndefined(opts.autocompleteMax) ? 20 : +opts.autocompleteMax;
    let completeBuckets = _.isUndefined(opts.autocompleteBuckets) ? 1 : +opts.autocompleteBuckets;
    let transactor = opts.useBatch ? 'batch' : 'multi';

    let utils = require('./utils')(client, opts);
    let redisScan = require('redis-scan')(client);

    // Add tags to the autocomplete system.
    // @param {Array} idxs  An array of <tagid>-<stemmed-tag> pairs
    //                      e.g. [4,lat,16,new`york,7,group...]
    // @param {Object} tagMap   A stem->fullTagName lookup
    //
    function addNewTags(idxs, tagMap) {

        // Simple counter for creating unique zset member strings
        //
        let inc;

        let compFrags = idxs.reduce((acc, seg, i) => {

            // 0 & evens = tagids. Store (unique) lastId to be used for
            // forming unique zset member strings.
            //
            if(!(i%2)) {
                acc.lastId = +seg;
                inc = 1;
                return acc;
            }

            let pref = seg.slice(0, 2);
            let suff = seg.slice(2);
            let orig = tagMap[seg];
            let lid = acc.lastId;
            let pHash = utils.getTagPrefixHash(pref);
            let group = pHash % completeBuckets;

            debug(`*${pref}`, orig, group);

            (acc.batch[group] = acc.batch[group] || []).push(pHash, `${orig}~${lid}.${inc}`);

            // Go through each char of #suff, add to #pref accumulator, hash result
            // into zset score, and add original tag as member (uniqueified using counter, etc)
            // e.g. if the tag was 'New York-based':
            //
            // <stemmed tag pref+suff> <zscore:hash> <zmember:origTag~tagId.counter>
            // 
            // ne 3295074444 New York-based~5.1
            // new 422208903 New York-based~5.2
            // new`y 1313305386 New York-based~5.3
            // new`yo 3086288393 New York-based~5.4
            // new`yor 1387557772 New York-based~5.5
            // new`york 945806695 New York-based~5.6
            // new`york`b 3496694347 New York-based~5.7
            // new`york`ba 1137583725 New York-based~5.8
            // new`york`bas 1657353072 New York-based~5.9
            // new`york`base 3712853072 New York-based~5.10
            //
            if(suff.length) {
                suff.split('').reduce((mem, s) => {

                    mem = mem + s;

                    // Ignore if segment ends with a space placeholder.
                    // @see utils#prepareTags
                    //
                    if(!/`$/.test(mem)) {
                        acc.batch[group].push(mh3(mem), `${orig}~${lid}.${++inc}`);

                        debug(mem, orig, group);
                    }

                    return mem;

                }, pref);
            }

            return acc;

        }, {
            lastId: 0,
            batch: {}
        });

        // Get all the autocomplete groups and send for insertion.
        //
        let batch = Object.keys(compFrags.batch).reduce((acc, grp) => {
            acc.push(['zadd', utils.namespaceKey(`tags:autocomplete:${grp}`), compFrags.batch[grp]]);
            return acc;
        }, []);

        return client[transactor](batch).execAsync();
    }

    // Scan the tags:autocomplete collection, find all matching tags, batch, and zrem batch.
    //
    function removeTags(stemmedTags, mapped) {

        stemmedTags = _.isArray(stemmedTags) ? stemmedTags : [stemmedTags];

        // Sort the stemmedTags into autocomplete zset groups:
        //
        let sort = stemmedTags.reduce((acc, tag) => {

            let grp = utils.getTagPrefixHash(tag) % completeBuckets;

            (acc[grp] = acc[grp] || []).push(mapped[tag]);

            return acc;

        }, {});

        // For each #grp, find members in zset and rem(ove) them.
        //
        return Promise.map(Object.keys(sort), grp => scan(grp, sort[grp])).then(res => {

            let batch = res.map(grpColl => ['zrem', grpColl.group].concat(grpColl.members));

            return client[transactor](batch).execAsync();
        });

        function scan(grp, tags) {

            // Create a regexp to match against scanned members, escaping regex operators.
            // e.g. Given tags ['politics','news'] -> /^(politics|news)/g
            // Note that the pipe(|) is not escaped.
            // TODO: tags that use pipe? Possible? Checks elsewhere?
            //
            let rex = new RegExp(`^(${tags.join('|').replace(/([.*+?^=!:${}()\[\]\/\\])/g, "\\$1")})`);
            let autoKey = utils.namespaceKey(`tags:autocomplete:${grp}`);

            return redisScan((acc, members) => {

                acc.members = acc.members.concat(members.filter((mem, idx) => {
                    return !(idx%2) && rex.test(mem);
                }));

                return acc;

            }, {
                group: autoKey,
                members : []
            }, 'zscan', { key: autoKey });
        }
    }

    // Request completions, returned as Array with maxlength #completeMaxItems
    //
    function complete(frag) {

        let prep = utils.prepareTags(frag);

        if(!prep) {
            return Promise.reject(new Error(`Invalid fragment sent to #autocomplete#complete. Received ${frag}`));
        }

        frag = prep.stems[0];

        if(!frag) {
            debug('Rejecting fragment', frag);
            return Promise.resolve([]);
        }

        let grp = utils.getTagPrefixHash(frag) % completeBuckets;
        let score = mh3(frag);

        debug('Accepting fragment', frag, grp, score);

        return client.zrangebyscoreAsync(
            [utils.namespaceKey(`tags:autocomplete:${grp}`), score, score, 'limit', 0, completeMaxItems]
        ).then(res => res.map(tag => tag.substring(0, tag.lastIndexOf('~'))));

    }

    // To disable just proxy to an "identity" function
    //
    function disable() {
        ['complete', 'addNewTags', 'removeTags']
        .forEach(m => api[m] = () => Promise.resolve([]));
    }

    function enable() {
        api.complete = complete;
        api.addNewTags = addNewTags;
        api.removeTags = removeTags;
        api.disable = disable;
        api.enable = enable;
    }

    enable();

    return api;
};

