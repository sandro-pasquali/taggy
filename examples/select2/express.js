'use strict';

let fs = require('fs');
let os = require('os');
let express = require('express');
let ecstatic = require('ecstatic');
let Promise = require('bluebird');
let _ = require('lodash');
let app = express();
let bodyParser = require('body-parser');
let taggy = require('../../lib')({
    useBatch: false,
    namespace: '__AUTOTEST__'
});

let states1 = _.chunk(require('./states'), 20);
let states2 = states1.slice(0).reverse();

states1.forEach((s1, idx) => {

    let grp = s1.concat(states2[idx]);
    taggy.add(grp, 99 + ++idx)
});

app.use(ecstatic({ root: __dirname  }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/autocomplete', (req, res) => {
    taggy.autocomplete.complete(req.query.q).then(tags => {
        res.statusCode = 200;
        res.send(tags);
    });
});

app.post('/search', (req, res) => {

    Promise.resolve(req.body.tags).then(JSON.parse)
    .then(ops => {

        console.log(ops);

        (['and','or','not'].reduce((search, op) => {
            console.log(op)
            ops[op].length && search[op](ops[op]);
            return search;
        }, taggy.search()))
        .run()
        .then(r => {
            res.status(200).json(r);
        })
    })
    .catch(err => {
        console.log(err)
        res.status(204).send();
    });
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

