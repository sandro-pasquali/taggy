'use strict';

const _ = require('lodash');
const mh3 = require('./murmurhash3');
const natural = require('natural');
const debug = require('debug')('utils');

// The characters expected to exist in (processed) tags in the first or
// second position. Note that processed tags are all lowercased.
//
const allowedTagChars = 'abcdefghijklmnopqrstuvwxyz1234567890#@:-$_';
const allowedCharsRegex = /[a-z|0-9|#@:\-$_]+/;

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

            return cand.some(i => _.isUndefined(i)) ? false : cand;
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

        const _tags = prepareTagsOrItems(tags);

        if(!_tags) {
            return _tags;
        }

        let stems = [];

        let mapped = _tags.reduce((acc, word, idx) => {

            // trim, no multi-space gaps, no diacritical marks (https://lodash.com/docs#deburr)
            //
            let trimmed = _.deburr(word.trim().replace(/\s+/g, ' '));

            let stem = stemmer ? stemmer.tokenizeAndStem(trimmed).join('`') : false;

            // In some cases (like when testing) the "words" sent may be a mix of random characters
            // that may stem to an empty string. Allow as long as #allowedTagChars matches on string.
            //
            // Alternatively, no stemmer was provided (see above).
            //
            // Just lowercase and manage spaces(`).
            //
            if(!stem && allowedCharsRegex.test(trimmed)) {
                stem = trimmed.split(/\s/).join('`').toLowerCase();
            }

            // If can't stem this still pushes an empty string.
            // Can't leave this #stems sparse (need identical count); no tag will be created for empty strings.
            //
            stems.push(stem || '');

            acc[stem] = trimmed;

            return acc;

        }, {});

        return {
            stems,
            originals: tags,
            mapped
        };
    }

    return {
        prepareTags,
        prepareItems,
        createTagKey,
        namespaceKey,
        getTagPrefixHash
    };

};