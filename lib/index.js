'use strict';

let Promise = require('bluebird');
let EventEmitter = require('events');
let redisHook = require('redis-hook');
let util = require('util');
let shortid = require('shortid');
let _ = require('lodash');
let debug = require('debug')('taggy:main');

module.exports = (opts) => {

    opts = opts || {};

    let client = redisHook(opts);
    let transactor = opts.useBatch ? 'batch' : 'multi';
    let namespace = opts.namespace;

    // Namespaces are important. If set, ensure that it is a String, or throw.
    //
    if(!_.isUndefined(namespace)) {
        if(!_.isString(namespace)) {
            debug(`Invalid #namespace argument sent. Received {${typeof namespace}}${namespace}`);
            process.exit(0);
        }
    } else {
        namespace = '';
    }

    let utils = require('./utils')(client, opts);
    let autocomplete = require('./autocomplete')(client, opts);
    let analytics = require('./analytics')(client, opts);
    let redisScan = require('redis-scan')(client);

    // Quick lookup of tag keys attached to a given itemId.
    //
    // HASH
    // <itemId> : [JSON array of tag keys]
    //
    let items_lookup = utils.namespaceKey('items:lookup');

    // Quick lookup of tagKey => originalTag
    //
    // HASH
    // <tagKey> : <originalTag>
    // e.g. "virtual`reality" : "virtual reality"
    //
    let tags_translate = utils.namespaceKey('tags:translate');

    // Collection of all tagKeys in system
    //
    // SET
    //
    let tags_set = utils.namespaceKey('tags:set');

    // Number of tags added to the system. Internal bookkeeping
    // NOTE: this always increments when a tag is added, and DOES NOT DECREMENT
    // when a tag is removed. It is not an accurate count of currently active tags.
    // To get an accurate count, use `SCARD tags::set`.
    //
    // STRING
    //
    let tags_count = utils.namespaceKey('tags:count');

    // Ordered set of tagKeys scored by id. Mainly internal, for
    // determining which tags were inserted when
    //
    // ZSET
    // e.g. <score:123> <member:someTagKey>
    //
    let tags_lookup = utils.namespaceKey('tags:lookup');

    util.inherits(Factory, EventEmitter);

    let inst = new Factory();

    client.on('ready', () => inst.emit('ready'));
    client.on('connect', () => inst.emit('connect'));
    client.on('reconnecting', dat => inst.emit('reconnecting', dat));
    client.on('error', err => inst.emit('error', err));
    client.on('end', () => inst.emit('end'));

    return inst;

    // The main API constructor:
    //
    // #add - Add tags to an item
    // #remove - Remove tags from an item
    // #tags - Get tags for an item
    // #search - Search items by tags
    // #removeItems - Remove an item from the system
    // #purgeTags - Remove all tags from the system
    // #cleanNamespace - Remove all tags associated with this instance namespace
    // #itemsExist - Check if items exist in the system
    // #tagsExist - Check if tags exist in the system
    //
    // #autocomplete :  A class providing public access to the following methods used
    //                  for autocompletion functionality:
    //  #complete - Given a string fragment return a list of matching tags
    //  #disable - Turn off autocompletion
    //  #enable - Turn on autocompletion
    //  #add - Add a tag to the autcomplete system THAT IS NOT part of the main tag indexes
    //  #remove - Remove a tag from the autocomplete model THAT IS NOT part of the main tag indexes
    //
    //
    function Factory() {

        EventEmitter.call(this);

        // Publicly accessible autocomplete methods (via taggy instance)
        //
        this.autocomplete = {

            complete : autocomplete.complete,
            disable : autocomplete.disable,
            enable : autocomplete.enable,

            add : tags => {

                let prep = utils.prepareTags(tags);

                // TODO: keep non-associated autocomplete tag set
                // check this when adding tags, and prune it as
                // tags in this non-associated set are eventually
                // associated through (normal) taggy.add process
                //

                //return addTagsAndFilter(prep.stems)
                //.then(idxs => autocomplete.addNewTags(idxs, prep.mapped));
            },
            remove : tags => {

                let prep = utils.prepareTags(tags);

                return autocomplete.removeTags(prep.stems, prep.mapped);
            }
        }

        // Apply tag(s) to item(s)
        //
        this.add = (tags, itemIds) => {

            let prep = utils.prepareTags(tags);

            if(!prep) {
                return Promise.reject(new Error(`Invalid tags sent to #add. Received ${tags}`));
            }

            let stemmedTags = prep.stems;

            itemIds = utils.prepareItems(itemIds);

            if(!itemIds) {
                return Promise.reject(new Error(`Invalid item ids sent to #add. Received ${itemIds}`));
            }

            // - Create or update tag key with itemIds
            // - Update item tags in items:lookup
            // - Update tags:set with new tags if any
            // - Get tag idx by updating tags:count
            // - Update idx, tag tuple in tags:lookup for new tags
            // - Add stem -> original lookup to tags:translate
            //
            return client[transactor](stemmedTags.map(tag => ['sadd', utils.createTagKey(tag), itemIds])).execAsync()
            .then(() => {

                return Promise.map(itemIds, id => {
                    return client
                    .hgetAsync(items_lookup, id)
                    .then(tagJson => {

                        tagJson = tagJson ? JSON.parse(tagJson) : [];

                        return client.hsetAsync(items_lookup, [id, JSON.stringify(_.union(tagJson, stemmedTags))]);
                    });
                });
            })
            .then(() => {
                // Update tags:set, also determining which tags are new.
                // #sadd returns 1 if a tag was added, 0 if not.
                // Build and return a [score,member...] pair array for all new tags.
                //
                return Promise.reduce(stemmedTags, (acc, tag) => {
                    return client
                    .saddAsync(tags_set, tag)
                    .then(added => {

                        if(added) {
                            return client.incrAsync(tags_count)
                            .then(cnt => {
                                acc.push(cnt, tag);
                            })
                        }
                    })
                    .then(() => acc)

                }, []);
            })
            .then(idxs => {

                // If no new tags we can bail here.
                //
                if(!idxs.length) {
                    return Promise.resolve();
                }

                return Promise.all([
                    autocomplete.addNewTags(idxs, prep.mapped),
                    client.zaddAsync(tags_lookup, idxs),
                    client.hmsetAsync(tags_translate, idxs.reduce((acc, stem, i) => {
                        (i%2) && acc.push(stem, prep.mapped[stem]);
                        return acc;
                    }, [])),
                    Promise.resolve(this.emit('tags-added', prep.mapped))
                ]);
            })
        };

        // Remove tags from items
        //
        this.remove = (tags, itemIds) => {

            let prep = utils.prepareTags(tags);

            if(!prep) {
                return Promise.reject(new Error(`Invalid tags sent to #remove. Received ${tags}`));
            }

            itemIds = utils.prepareItems(itemIds);

            if(!itemIds) {
                return Promise.reject(new Error(`Invalid items sent to #remove. Received ${itemIds}`));
            }

            return client
            .hmgetAsync(items_lookup, itemIds)
            .then(tagArr => {

                let itemColl = [];
                let batch = [];

                tagArr.forEach((json, idx) => {

                    // hmget always returns an array, but if a nonexistent field is sent
                    // the result will be null value. Skip those.
                    //
                    if(json === null) {
                        return;
                    }

                    // Remove sent tags from existing tags.
                    //
                    let tagJson = JSON.parse(json);
                    let newV = _.difference(tagJson, prep.stems);
                    let itemId = itemIds[idx];

                    itemColl = itemColl.concat(itemId, JSON.stringify(newV));

                    batch = batch.concat(tagJson.map(t => ['srem', utils.createTagKey(t), itemId]));
                });

                return client
                .hmsetAsync(items_lookup, itemColl)
                .then(() => {
                    return client[transactor](batch).execAsync();
                })
            })
        };

        // Force-apply tags to an item. When complete item has ONLY these sent tags.
        //
        this.replace = (tags, itemId) => {

            return this
            .tags(itemId)
            .then(tagset => {

                // Can only replace tags on an existing item.
                // If doesn't exist, just #add
                //
                if(Object.keys(tagset).length) {
                    return this
                    .remove(tagset[itemId], itemId)
                    .then(() => this.add(tags, itemId));
                }
                return this.add(tags, itemId);
            })
        };

        // Get tags associated with items.
        //
        this.tags = itemIds => {

            itemIds = utils.prepareItems(itemIds);

            if(!itemIds) {
                return Promise.reject(new Error(`Invalid items sent to #tags. Received ${itemIds}`));
            }

            return client
            .hmgetAsync(items_lookup, itemIds)
            .then(tagArr => {

                return tagArr.reduce((acc, json, idx) => {

                    if(json) {
                        acc[itemIds[idx]] = JSON.parse(json);
                    }

                    return acc;

                }, {});
            })
            .then(res => {
                return Promise.reduce(Object.keys(res), (acc, itemId) => {

                    // May have no associated tags (an empty array)
                    //
                    if(!res[itemId] || !res[itemId].length) {
                        return Promise.resolve(acc);
                    }

                    return client.hmgetAsync(tags_translate, res[itemId])
                    .then(trans => {
                        acc[itemId] = trans;
                        return acc;
                    });

                }, {});
            });
        };

        // Get items associated with a SINGLE tag.
        // Use #search to grab associations for multiple tags.
        //
        this.items = tag => {

            if(!_.isString(tag) || !tag.length) {
                return Promise.reject(new Error(`#items accepts only a single tag string. Use #search for multiple tag search. Received: ${tag}`));
            }

            let prep = utils.prepareTags(tag);

            let tKey = utils.createTagKey(prep.stems[0]);

            return client.smembersAsync(tKey);
        };

        // List of all tags
        //
        this.tagList = withStems => {
            return client
            .smembersAsync(tags_set)
            .then(tags => {
                return client.hgetallAsync(tags_translate)
                .then(trans => tags.sort().map(t => {
                    return withStems ? {
                        o: trans[t],
                        s: t
                    } : trans[t];
                }));
            })
        };

        // Fully remove an item from the system.
        //
        this.removeItems = itemIds => {

            itemIds = utils.prepareItems(itemIds);

            if(!itemIds) {
                return Promise.reject(new Error(`Invalid items sent to #removeItems. Received ${itemIds}`));
            }

            return client
            .hmgetAsync(items_lookup, itemIds)
            .then(tagArr => {

                let batch = [];

                tagArr.forEach(json => {

                    // hmget always returns an array, but if a nonexistent field is sent
                    // the result will be null value. Skip those.
                    //
                    if(json === null) {
                        return;
                    }

                    let tags = JSON.parse(json);
                    let tagSetKeys = tags.map(utils.createTagKey);

                    // Delete itemId member in each associated tag set.
                    //
                    tagSetKeys.forEach(mt => batch.push(['srem', mt, itemIds]));
                });

                batch.push(['hdel', items_lookup].concat(itemIds));

                return client[transactor](batch).execAsync();
            })
        };

        // Fully purge all given tags from system.
        // Given tags no longer exist for items, or in any other way.
        //
        this.purgeTags = tags => {

            let prep = utils.prepareTags(tags);

            if(!prep) {
                return Promise.reject(new Error(`Invalid tags sent to #purgeTags. Received ${tags}`));
            }

            let stemmedTags = prep.stems;
            let tagSetKeys = stemmedTags.map(utils.createTagKey);

            // Get Union of all #itemIds across all given tag sets (a list of #itemIds)
            //
            return client
            .sunionAsync(tagSetKeys)
            .then(itemIds => {

                // Get the tags associated with given items.
                //
                return client
                .hmgetAsync(items_lookup, itemIds)
                .then(jsonVals => {

                    let setfv = [];

                    // Find and remove targeted tags from associated items, storing new tag list.
                    // Note that there may be null tags for a given index (the sent item may
                    // not exist in items:lookup -- Redis returns nil -> null in JS). Skip those.
                    //
                    jsonVals.map((v, idx) => {

                        if(v !== null) {
                            let newV = _.difference(JSON.parse(v), stemmedTags);
                            setfv.push(itemIds[idx], JSON.stringify(newV));
                        }
                    });

                    return Promise.all([
                        client.hmsetAsync(items_lookup, setfv), // update tag list for affected items
                        client.delAsync(tagSetKeys), // remove tag sets
                        client.sremAsync(tags_set, stemmedTags), // remove from list of all tags
                        client.zremAsync(tags_lookup, stemmedTags), // remove from tag id -> tag stem lookup
                        client.hdelAsync(tags_translate, stemmedTags), // remove from tag stem -> original lookup
                        autocomplete.removeTags(stemmedTags, prep.mapped)
                    ]);
                });
            });
        };

        // Reduce the DB to a JSON representation that can be used to
        // recreate the DB (via #inflate). This is a backup strategy.
        // @see #inflate
        //
        this.deflate = () => client
        .hgetallAsync(items_lookup)
        .then(items => {
            // Note: tag stems are translated back into original
            // [ [['tag','tag','tag'], itemId1]], [['tag','tag','tag'], itemId2]], ... ]
            //
            return client
            .hgetallAsync(tags_translate)
            .then(trans => Object.keys(items).map(it => [JSON.parse(items[it]).map(t => trans[t]), it]));
        })
        .then(JSON.stringify);

        // Rebuild/augment a DB using the result of a #deflate
        // Note #mapSeries. Each addition will be done serially. This
        // means the resulting array will contain a Boolean indicating
        // whether the insertion was successful, matching initial tag ordering.
        //
        this.inflate = serialized => Promise.resolve(JSON.parse(serialized))
        .then(arr => {
            debug(`Inflate: ${arr.length} items may be added`);
            return Promise.mapSeries(arr.map(args => {
                debug(`Inflate: Adding tags ${args[0]} to item ${args[1]}`);
                return this.add(args[0], args[1]);
            }), aOp => aOp !== undefined);
        });

        // Scans keyspace for any keys with given :namespace: and removes them
        //
        this.cleanNamespace = () => redisScan((acc, scn) => {
            acc = acc.concat(scn);
            return acc;
        }, [], 'scan', {
            match : `*:${namespace}:*`,
            count : 20
        })
        .then(doomed => (_.isArray(doomed) && doomed.length) ? client.delAsync(doomed) : Promise.resolve([]));


        // Of the tags sent, returns array of those that exist.
        //
        this.tagsExist = tags => {

            let prep = utils.prepareTags(tags);

            if(!prep) {
                return Promise.reject(new Error(`Invalid tags sent to #tagsExist. Received ${tags}`));
            }

            return client[transactor](prep.stems.map(t => ['exists', utils.createTagKey(t)]))
            .execAsync()
            .reduce((acc, ex, idx) => {
                ex && acc.push(prep.originals[idx]);
                return acc;
            }, []);
        };

        // Of the items sent, returns an array of those that exist
        //
        this.itemsExist = itemIds => {

            itemIds = utils.prepareItems(itemIds);

            if(!itemIds) {
                return Promise.reject(new Error(`Invalid items sent to #itemsExist. Recieve ${itemIds}`));
            }

            return client.hmgetAsync(items_lookup, itemIds).reduce((acc, i, idx) => {
                i !== null && acc.push(itemIds[idx]);
                return acc;
            }, []);
        };

        this.search = baseSet => {

            let cleanup = [];
            let lastTempKey = _.isString(baseSet) ? [baseSet] : [];
            let batch = [];
            let tempId = shortid.generate();
            let opMap = {
                'sinterstore': 'and',
                'sunionstore': 'or',
                'sdiffstore': 'not'
            };

            function createConditional(op) {

                // One transaction can have multiple AND/OR/NOT, so add discriminator
                //
                let inc = 0;

                return tags => {

                    let tempStoreKey = `TT:${opMap[op]}${++inc}:${tempId}`;

                    let prep = utils.prepareTags(tags);

                    if(!prep) {
                        return Promise.reject(new Error(`Invalid tags sent to #search#${opMap[op]}. Received ${tags}`));
                    }

                    // Always running an operation against the last stored operation key (if available)
                    //
                    batch.push(
                        [op, tempStoreKey]
                        .concat(lastTempKey)
                        .concat(prep.stems.map(utils.createTagKey))
                    );

                    lastTempKey = [tempStoreKey];
                    cleanup.push(tempStoreKey);

                    return api;
                };
            }

            function clean() {
                return client.delAsync(cleanup);
            }

            function serialize() {

                // Create a replay script
                //
                let replay = batch.map(ins => {
                    let rob = {
                        op: opMap[ins.shift()],
                        tags: []
                    };

                    // We only want to keep tag operations, not temp tags.
                    // For tag: segments, keep only the tag stem itself, losing tag: prefix
                    // tag format: `tag:<optional namespace>:<tag>` (ie. could be tag::politics => 'politics')
                    //
                    return ins.reduce((acc, seg) => {

                        /^tag:/.test(seg) && acc.tags.push(seg.replace(/^tag:[^:]*:/, ''));

                        return acc;

                    }, rob);
                });

                return JSON.stringify(replay);
            }

            let api = {

                replay : strOrObjJson => {

                    try {
                        (_.isString(strOrObjJson) ? JSON.parse(strOrObjJson) : strOrObjJson)
                        .forEach(ins => api[ins.op](ins.tags));
                    } catch(e) {
                        throw e;
                    }

                    return api;
                },

                // Pass `true` to retrieve the call macro (serialized, tokenized #batch)
                //
                run : ser => {

                    if(ser) {
                        return clean().then(serialize);
                    }

                    // After running the transaction read members @lastTempKey and return.
                    //
                    return client[transactor](batch).execAsync()
                    .then(res => client.smembersAsync(lastTempKey))
                    .then(mems => Promise.resolve(mems))
                    .finally(clean)
                }
            };

            // Add the 'and', 'or', 'not' operations on #api
            //
            Object.keys(opMap).forEach(op => api[opMap[op]] = createConditional(op));

            return api;
        };
    }
};