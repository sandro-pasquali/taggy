'use strict';

let _ = require('lodash');
let mh3 = require('./murmurhash3');
let natural = require('natural');
let debug = require('debug')('utils');

// The characters expected to exist in (processed) tags in the first or
// second position. Note that processed tags are all lowercased.
//
let allowedTagChars = 'abcdefghijklmnopqrstuvwxyz1234567890(#@:-$_';

// Characters that are expected to be the first or second character of a tag.
// (<allowedTagChars> ^ 2)(2 * 4) = total bytes (murmurhash <= 32 bit number = 4 bytes)
//
let prefLookup = allowedTagChars.split('').reduce((acc, c1, idx) => {
    allowedTagChars.split('').forEach(c2 => {
        let pair = `${c1}${c2}`;
        acc[pair] = mh3(pair);
    });
    return acc;
}, {});

module.exports = (client, opts) => {

    opts = opts || {};

    let stemmer = _.isString(opts.stemmer) ? natural[`${_.capitalize(opts.stemmer)}Stemmer`] : false;

    let namespace = _.isString(opts.namespace) ? opts.namespace : '';

    function createTagKey(tag) {
        return namespaceKey(`tag:${tag}`);
    }

    // Replace only the FIRST occurrence of `:` with a namespace token.
    //
    function namespaceKey(key) {
        return key.replace(/:/, `:${namespace}:`);
    }

    function getTagPrefixHash(tag) {

        tag = tag.toLowerCase();
        let pref = tag.slice(0,2);

        // For unexpected prefixes just create hash directly
        //
        return prefLookup[pref] || mh3(pref);
    }
    
    function prepareTagsOrItems(cand) {
        if(_.isArray(cand)) {

            if(cand.length === 0) {
                return false;
            }

            if(!cand.some(i => _.isUndefined(i))) {
                return cand;
            }
        }

        if(_.isString(cand) && cand.length) {
            return [cand];
        }

        return _.isUndefined(cand) ? false : [cand];
    }

    function prepareItems(itemIds) {
        return prepareTagsOrItems(itemIds);
    }

    // Note that stemmer excludes tags identified as stop words.
    // TODO: option for keeping stop words?
    //
    function prepareTags(tags) {

        tags = prepareTagsOrItems(tags);

        if(!tags) {
            return tags;
        }

        let stems = [];

        let mapped = tags.reduce((acc, word, idx) => {

            // trim, no multi-space gaps, no diacritical marks (https://lodash.com/docs#deburr)
            //
            word = _.deburr(word.trim().replace(/\s+/g, ' '));

            // Join multi-token tags into a single tag, w/ space placeholder
            // If not stemming, stem is essentially the tag lowercased.
            //
            let stem = stemmer
                    ? stemmer.tokenizeAndStem(word).join('`')
                    : word.split(/\s/).join('`').toLowerCase();

            stems.push(stem);

            acc[stem] = word;

            return acc;

        }, {});

        return {
            stems: stems,
            originals: tags,
            mapped: mapped
        };
    }

    return {
        prepareTags : prepareTags,
        prepareItems : prepareItems,
        createTagKey : createTagKey,
        namespaceKey : namespaceKey,
        getTagPrefixHash : getTagPrefixHash
    };

};