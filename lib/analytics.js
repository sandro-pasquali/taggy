'use strict';

let Promise = require('bluebird');

module.exports = (client, opts) => {

    opts = opts || {};

    let utils = require('./utils')(client, opts);

    function recordSearch() {

    }

    return {};
};


/*

 var dt = new Date();
 var secs = dt.getSeconds() + (60 * dt.getMinutes()) + (60 * 60 * dt.getHours());

 var dt = new Date();
 var minutes = dt.getMinutes() + (60 * dt.getHours());

 */