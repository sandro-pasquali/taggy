'use strict';

const taggy = require('../../lib')({
    useBatch: false,
    stemmer: 'porter',
    namespace: '__TESTSPACE__'
});

taggy.on('ready', () => debug('Redis:ready'));
taggy.on('connect', () => debug('Redis:connect'));
taggy.on('reconnecting', dat => debug(`Redis:reconnecting ${dat}`));
taggy.on('error', err => debug(`Redis:error ${err}`));
taggy.on('end', () => debug('Redis:end'));

const util = require('util');
const debug = require('debug')('taggy:test');
const _ = require('lodash');
const client = require('redis-hook')({});

module.exports = function(test, Promise) {

    // The context that carries forward through the Promise chain
    //
    this.events = {};

    Promise.config({
        longStackTraces: true
    });

    return Promise.resolve()

    // Test that we're receiving events
    //
    .then(() => {

        taggy.on('tags-added', tags => {
            this.events['tags-added'] = tags;
        });

        taggy.autocomplete.disable();
        taggy.autocomplete.enable();

        test.ok(_.isFunction(taggy.autocomplete['complete']), 'Can enable/disable autocomplete');

        return Promise.all(
            taggy.add(['_$$__0','_$$__2','_$$__3','_$$__4','   lãtviešu     valoda     ','Latvian','$$latitudes','latitudinal'], '_ID_2$'),
            taggy.add(['_$$__2','_$$__4','New York-based', 'wwvc2016'], '_ID_4$'),
            taggy.add(['aa','bb','ccc'], 'testupdate')
        )
    })

    // Grabbing index
    //
    .then(() => {
        return taggy
        .deflate()
        .then(ser => {
            test.looseEqual(ser, `[[["aa","bb","ccc"],"testupdate"],[["_$$__0","_$$__2","_$$__3","_$$__4","latviesu valoda","Latvian","$$latitudes","latitudinal"],"_ID_2$"],[["_$$__2","_$$__4","New York-based","wwvc2016"],"_ID_4$"]]`, 'Correctly #deflating');

            return taggy.inflate(ser).then(res => {
                test.looseEqual(res, [false, false, false], 'Correctly #inflating');
                debug(res)
            })
        });
    })

    // Replacing tags
    //
    .then(() => {

        const rtags = ['aa2','bb2','ccc2'];

        return taggy
        .replace(rtags, 'testupdate')
        .then(() => {
            return taggy
            .tags('testupdate')
            .then(tags => {

                test.looseEqual(tags, {testupdate:rtags}, 'Can properly replace tags on items');

                return taggy.remove(rtags, 'testupdate');
            })
        })
    })

    // Item and tag existence
    //
    .then(() => {
        return taggy
        .tagsExist(['nonexi','New York-based','stenttag','wwvc2016'])
        .then(res => {
            test.looseEqual(res, ['New York-based','wwvc2016'], 'Can properly check for existing tags');

            return taggy.itemsExist(['nonexi','_ID_4$','stentitem','_ID_2$']);
        })
        .then(res => {
            test.looseEqual(res, ['_ID_4$','_ID_2$'], 'Can properly check for existing items');
        });
    })

    // Search ok, and can re-run a search.
    //
    .then(() => {

        this.firstSearch = taggy.search();

        return this.firstSearch
        .and(['_$$__4','_$$__2'])
        .not(['_$$__3'])
        .run()
        .then(res => {

            test.looseEqual(res, ['_ID_4$'], 'Search #1: Successful AND -> DIFF');

            debug(res);

            return this.firstSearch.run();
        })
        .then(res => {

            test.looseEqual(res, ['_ID_4$'], 'Successfully repeated search #1');
        })
        .then(() => {
            this.secondSearch = taggy.search();

            return this.secondSearch
            .or(['_$$__4','_$$__2'])
            .and(['_$$__3'])
            .run();
        });
    })

    // Tag removal (and fetching) works
    //
    .then(res => {

        test.looseEqual(res, ['_ID_2$'], 'Search #2: Successful OR -> AND');

        return taggy
        .tags(['_ID_2$','_ID_4$','nonexistentId'])
        .then(tagsFor => {
            test.looseEqual(tagsFor, {
                '_ID_2$': [
                    '_$$__0',
                    '_$$__2',
                    '_$$__3',
                    '_$$__4',
                    'latviesu valoda',
                    'Latvian',
                    '$$latitudes',
                    'latitudinal'
                ],
                '_ID_4$': [
                    '_$$__2',
                    '_$$__4',
                    'New York-based',
                    'wwvc2016'
                ]
            }, 'Correctly fetching translated tags for items and handling nonexistent items');

            return taggy.remove([
                '_$$__0',
                '_$$__2',
                '_$$__3',
                '_$$__4',
                'latviešu valoda',
                'Latvian',
                '$$latitudes'
            ], ['_ID_2$', 'nonexistentId']);
        })
        .then(() => taggy.tags(['_ID_2$','nonexistentId']))
        .then(tagsFor => {

            test.looseEqual(tagsFor, {
                '_ID_2$': ['latitudinal']
            }, 'Correctly removing tags from items and handling nonexistent items');

            return taggy.removeItems(['_ID_2$', 'nonexistentId']);
        })
        .then(() => taggy.tags(['_ID_2$','_ID_4$']))
        .then(tagsFor => {
            test.looseEqual(tagsFor, {
                '_ID_4$': [ '_$$__2', '_$$__4', 'New York-based', 'wwvc2016']
            }, 'Correctly removing items');
        });
    })

    // Grab a replay macro for search#1, run it, and confirm result
    //
    .then(res => {
        return this.firstSearch
        .run(true)
        .then(macro => {

            debug('replay', macro);

            return taggy.search().replay(macro).run();
        })
        .then(res => {
            test.looseEqual(res, ['_ID_4$'], 'Successfully ran replay of search #1');
        });
    })

    // Autocompletion
    //
    .then(() => {

        let frags = {
            'la': ['$$latitudes', 'Latvian', 'latitudinal', 'latviesu valoda'],
            'latv': ['Latvian', 'latviesu valoda'],
            'latitudi': ['latitudinal'],
            'new york': ['New York-based']
        };

        return Promise.all(Object.keys(frags).map(frag => {
            return taggy.autocomplete.complete(frag)
            .then(comp => {
                return test.looseEqual(comp, frags[frag], `Successful autocompletion: ${frag}`);
            })
        }));
    })

    // Test *autocomplete* tag removal.
    //
    .then(res => {

        return taggy.autocomplete
        .remove([
            'New York-based',
            'latitudinal'
        ])
        .then(res => {
            const frags = {
                'la': ['$$latitudes', 'Latvian', 'latviesu valoda'],
                'latv': ['Latvian', 'latviesu valoda'],
                'latitudi': ['latitudinal'],
                'new york': ['New York-based']
            };

            // The first two groups should complete; the last two should fail
            //
            return Promise.all(Object.keys(frags).map((frag, idx) => {
                return taggy.autocomplete.complete(frag)
                .then(comp => {

                    if(idx < 2) {
                        test.looseEqual(comp, frags[frag], `Successful autocompletion: ${frag}`);
                    } else {
                        test.notLooseEqual(comp, frags[frag], `Correctly removed autocomplete tags for: ${frag}`);
                    }
                })
            }));
        })
    })

    // Purge every tag but 'New York-based'
    //
    .then(res => {

        return taggy
        .purgeTags([
            '_$$__0',
            '_$$__1',
            '_$$__2',
            '_$$__3',
            '_$$__4',
            'latviešu valoda',
            '$$latitudes',
            'latitudinal',
            'Latvian',
            'New York-based',
            'wwvc2016'
        ])
        .then(res => debug('purge', res));
    })

    // Check the final state of items and their tags. This is important.
    //
    .then(() => {
        return client
        .hgetallAsync('items:__TESTSPACE__:lookup')
        .then(fin => {
            test.looseEqual(fin, { testupdate: '[]', '_ID_4$': '[]' }, 'Saw expected final state in items:lookup');
        });
    })

    .catch(err => {
        test.fail(err);
    })

    .finally(() => {


        // Just cleanup, esp. if tests error. Ok to disable this if you want to check key states
        //
        return taggy.cleanNamespace().then(debug).catch(debug);

    })
};