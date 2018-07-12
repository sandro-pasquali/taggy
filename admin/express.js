'use strict';

let fs = require('fs');
let os = require('os');
let express = require('express');
let ecstatic = require('ecstatic');
let Promise = require('bluebird');
let _ = require('lodash');
let app = express();
let bodyParser = require('body-parser');
let taggy = require('../lib')({
    useBatch: false,
    namespace: '__ADMINTEST__'
});

let states1 = _.chunk(require('./states'), 20);
let states2 = states1.slice(0).reverse();

states1.forEach((s1, idx) => {

    let grp = s1.concat(states2[idx]);
    taggy.add(grp, 99 + ++idx)
});

app.use(ecstatic({
    root: __dirname + '/ui'
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/autocomplete', (req, res) => {
    taggy.autocomplete.complete(req.query.q).then(tags => {
        res.statusCode = 200;
        res.send(tags);
    });
});

app.post('/search', (req, res) => {

    Promise.try(() => {
        return JSON.parse(req.body.tags);
    })
    .then(ops => {

        if(ops.and.length === 0 && ops.or.length === 0) {
            return res.status(400).send('Must sent AND or OR tags. Neither received');
        }

        (['and','or','not'].reduce((search, op) => {
            ops[op].length && search[op](ops[op]);
            return search;
        }, taggy.search()))
        .run()
        .then(r => {

            return taggy.tags(r).then(tags => res.status(200).json(tags));
        })
        .catch(err => {
            // Just return empty array on error. This may just mean that no
            // tags were found. TODO: more involved checking of response.
            //
            res.status(200).json([]);
        })
    })
    .catch(err => {
        res.status(500).send(`Cannot process search. Server not processing body? Received operations: ${req.body}.`);
    });
});

app.get('/all', (req, res) => {
    // Fetch all tags w/ stems include (`true` arg)
    //
    taggy.tagList(true)
    .then(list => res.status(200).json(list))
    .catch(err => res.status(400).send(err));
});

app.get('/itemized', (req, res) => {
    taggy.deflate()
    .then(json => res.status(200).json(JSON.parse(json)))
    .catch(err => res.status(400).send(err));
});

app.post('/updatetags', (req, res) => {

    let changes = JSON.parse(req.body.data);

    Promise.all(changes.reduce((acc, it) => {

        let pair = it;
        let id;
        let orig;
        let delta;

        if(Array.isArray(it[1])) {
            pair = it[1];
            id = it[0];
        }

        orig = pair[0];
        delta = pair[1];

        // Asking for a given tag to be changed (maybe deleted) across system.
        // - Get all the items associated with this tag.
        // - Fully purge the tag
        // - If there is a change to the tag, re-add new tag to stored itemIds.
        // - If the change is empty (""), no new tag is added to replace old one.
        //
        if(!id) {

            acc.push(taggy.items(orig)
            .then(exItems => {
                return taggy.purgeTags(orig).then(() => {
                    return delta ? taggy.add(delta, exItems) : Promise.resolve();
                })
            }));

        // Asking for a given tag to be changed (maybe deleted) for a single itemId
        // - Remove the tag from the item.
        // - If there is a change to the tag, re-add new tag to item.
        // - If the change is empty (""), no new tag is added to replace old one.
        //
        } else {

            acc.push(taggy.remove(orig, id)
            .then(() => {
                return delta ? taggy.add(delta, id) : Promise.resolve();
            }));
        }

        return acc;

    }, []))

    .then(() => res.status(200).end())
    .catch(err => res.status(400).send(err.message));

});

let server = app.listen(8082, () => {
    console.log('Express server listening on 8082');
});

// Whenever this server/process is terminated/errors be sure to clean up test namespace
//
function exitHandler(err) {

    if(err) {
        console.log(err);
    }

    taggy.cleanNamespace().then(x => process.exit(0));
}

process.on('exit', exitHandler);
process.on('SIGINT', exitHandler);
process.on('uncaughtException', exitHandler);

