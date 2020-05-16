# Taggy

A tagging library for Redis. You _**must**_ use `Redis 3.0.3` _or_ higher.

You'll want to use this when you have access to some set of `Item` ids (articles, images, etc) and you want to be able to categorize, and search, those items using tags.

## Install

`npm install taggy`

## Initialize

`let taggy = require('taggy')(<options>)`

## Options

* `useBatch` - By default operations are run as transactions using `MULTI`. This allows for transaction rollbacks should something go wrong, and probably what you need. `useBatch` when you aren't interested in this sort of transactional support, and only in cases where you've tested this option against a real world case (tag operations across very large numbers of tags) and found that it provides a speed boost. It is unlikely that it does.
* `stemmer` - One of `porter` or `lancaster`. Default is `porter`. See [natural module](https://github.com/NaturalNode/natural#stemmers). If not set, tags are not stemmed. If enabled tags are represented/stored in stemmed format (which saves memory and can provide for faster lookups, but is fuzzier on matches, losing stop words, pluralizations, and so on). If no stemmer is given, stemming does not happen. Recommend using stemming, disabling if your real world users report difficulties with this level of precision.
* `namespace` - Namespace for tags. This allows you to have multiple `taggy` instances running against different namespaces. If you set `namespace` to 'images' your `taggy` instance performs searches against tags with the prefix `tag:images:<tag>`. Default is no namespace (`tag::<tag>`).
* `autocomplete` - Whether to enable tag autocompletion functionality. See [below](#getting-tags)
* `autocompleteMax` - The maximum number of results returned by `taggy.autocomplete.complete`. Default is `20`.
* `autocompleteBuckets` - The number of shards the autocompletion index is broken into. Default is `1`. Note that this is *not* a horizontal scaling effort, but a simple sharding across multiple keys within a single Redis instance. Why? Autocomplete sets are sorted sets queried using `zrangebyscore`, which runs at `O(log(N))`. You can reduce the average `N` by sharding. Note that in most cases this is not going to give you an appreciable speed bump, so it is perfectly reasonable to leave this value as `1`.

* This library uses Redis. Any other options sent will be passed on to the Redis constructor. For a list, see options for the [`redis` module](https://github.com/NodeRedis/node_redis#options-is-an-object-with-the-following-possible-properties).

## Adding tags to an item

```
taggy.add(<array or string>Tags, <some sort of unique id>Item)
```

Returns `Promise`.

## Removing tags from items

```
taggy.remove(<array or string>Tags, <array or string>Items)
```

Returns `Promise`.

## Getting tags for items <a name="getting-tags" />

```
taggy.tags(<array or string>Items)
```

Returns `Promise`.

## Removing items from the tagging system

```
taggy.removeItems(<array or string>Items)
```

Returns `Promise`.

## Removing tags from the tagging system

```
taggy.purgeTags(<array or string>Tags)
```

Returns `Promise`.

## Performing searches for items 

Once items are tagged you're going to want to perform searches against those tags.

To begin, create a `search` instance:

```
let search = taggy.search()
```

Searches use `and`, `or`, and `not` operators. Consider:

```
taggy.search()
.and(['news','politics'])
.not(['trump'])
.run();
```

The above search will return all items tagged with `news AND politics`, but `NOT` those tagged with `trump`.

You can chain any number of these operations together, as shown below:

```
// tagName{item,ids,here}:
// tagA{'a','b','c'}, tagB{'b','c','d','f'}, tagC{'a','e','f'}, tagD{'a','b','f'}
//
let mysearch = taggy.search()
.and(['tagA','tagB']) // {b,c}
.and(['tagD']) // {b}
.or(['tagC']) // {b,a,e,f}
.not(['tagB']) // {a,e}
.run(); // returns {a,e}
```

To execute the search, you must terminate the chain with `run`. 

`run` returns the `Promise` of an array of results. If there are no results, an empty array is returned.

## Re-using search instances

You can re-use a search instance. Consider the above example. You can re-run `mysearch`:

```
mysearch.run(); // {a,e}
```

Note that this is a true re-execution -- the result is not cached, but re-calculated. 

## Replaying searches on top of other searches

You can grab a serialized representation of a search (a `macro`) and `replay` it elsewhere. 

For example, if `mySearch` is a search returning `['a','b']`, you can grab that search macro (a JSON string) by passing `true` to the `run` method:

```
let macro = mysearch.run(true);
```

`run(true)` returns the `Promise` of a serialized `macro`. You can replay this against another search:

```
let otherSearch = taggy.search().replay(macro).run(); // Promise(['a','b'])
```

You can replay any number of macros:

```
taggy.search().replay(macro1).replay(macro2).run();
```

Note that a `macro` expands into a sequence of operations against the tag space (as defined by the search instance it was derived from). It is not a cached result, or otherwise idempotent. This means that replaying a `macro` returns the result of its operations against the current tag space, which may differ from what the original search returned.

Use macros when you want to store a useful and-or-not sequence as a sort of reusable function. If you were tagging users, you might use something like:

```
let frenchUpsell = search().and(['new','french']).not('paying').run(true);
// When you want to target these users...
search().replay(frenchUpsell).run();
```

Macros are also useful when running searches across namespaces:

```
let ns1 = taggy({ namespace: 'ns1' })
let ns2 = taggy({ namespace: 'ns2' })

let ns1Macro = ns1.search().and([...]).run(true);

let finalResult = ns2.search().replay(ns1Macro).and([...]).or([...]).run();

```

## Autocompletion

`taggy` has built-in tag autocompletion support. Typically you'll want to use this when your UI has some sort of feature where users receive a list of possible tags as they type.

Whenever you add a tag to the system via `taggy.add` that tag will be automatically indexed for autocompletion.

To disable autocompletion:

```
taggy.autocomplete.disable();
```

To enable:

```
taggy.autocomplete.enable();
```

To use:

```
taggy.complete(<a String>);
```

`complete` returns the `Promise` of an array of results. An empty array is returned if there are no results.

## Backups

The entire tagging DB can be deflated into a serialized string of `taggy.add` arguments that can later be used to hydrate a DB -- either building a new one from scratch, or adding to an existing DB. If you aren't persisting your Redis DB this is an alternate way of backing up your data. 

```
let serialized = taggy.deflate(); 

(Returns a String; broken out here for readability)
'[
    [["foo","bar",...], "someId"],
    [["baz"], "someotherId"]
]'
```

To rehydrate (inflate):

```
taggy.inflate(serialized);
```

Inflating is the equivalent of calling `taggy.add` for each item. For the above:

```
taggy.add(["foo","bar"], "someId")
taggy.add(["baz"], "someotherId")
...
```

Because a deflation is just a serialized list of add operations, you can also inflate a deflated index into an existing DB. Note that duplication does not occur (duplicate tags/items are simply ignored), so you can perform tag library merges this way.

`taggy.inflate` returns an ordered list containing the Boolean result of each `taggy.add` operation performed, matching the original operation ordering. For example:

```
[true, true, false, true] 
[false, false]

etc.
```

Note that a `false` value may simply denote that the operation didn't create new tags (ie. the tag/item pairing already exists so was ignored); it isn't necessarily an insert error.

## Testing and debugging

`npm test`

Additional debugging information can be enabled by adding `DEBUG=*` to your environment. For example:

```
DEBUG=* npm test

or

DEBUG=* node someScriptThatRunsTaggy
```

Debugging info is split into these groups: `main`, `autocomplete`, and `test`. `*` Displays all. To limit debugging info simply list specific groups. For example:

```
DEBUG=main,test someScriptThatRunsTaggy
```

## Admin

There is a basic test administration interface in the `/api` folder.

Start it with `node admin/express`

This interface demonstrates how you might administer your tags. It allows you to view a list of all tags (along with the stemmed representation), as well as the items->tags associations as they exist in the test dataset.

### Tag list

The `Tags` button will produce a list of all tags in the system (under the `__ADMINTEST__` namespace).

You will see something like this:

```
array [102]
	0 {2}
        o	:	Alabama
        s	:	alabama
	1 {2}
        o	:	Alaska
        s	:	alaska
    .
    .
    .
```

Each tag in the system is represented under the key `o(riginal)`; its `(s)tem` representation is paired. 

You can edit the `original` tag (one or many), and after clicking `Update` that tag will be *rewritten* in the system. 

For example, changing `Alabama` to `Bama` will *destroy* the `Alabama` tag and add a new tag `Bama`. All items that were previously associated with `Alabama` will now be associated with `Bama`. Again, the `Alabama` tag will *no longer exist*.

To completely remove rather than replace a tag simply erase it (delete all the characters) and `Update`.

Changes to `stems` are ignored. They are presented to give you visibility into how the `original` tag is represented. You cannot change `stems`, only `originals`.

### Items

The `Items` button will produce a map of items -> tags. 

You will see something like this:

```
object {6}
	100		[22]
	101		[40]
	102		[40]
	103		[40]
	104		[40]
	105		[22]

```

This indicates that there are `{6}` item ids recognized by the system, here being the item ids {100...105}, with the number of tags associated with each item id ([22], [40], etc.).

Expanding you will see something like this:

```
object {6}
	100		[22]
        0	:	Alabama
        1	:	Alaska
        2	:	Arizona
        3	:	Arkansas
        .
        .
        .

```

You may now change the tags associate with item ids. Unlike with the general tag list, changing a tag here will result in the removal of that tag from the *item only*, replacing it with the changed tag.

For example, changing `Alabama` to `Bama` here will only replace `Alabama` with `Bama` for the item id `100`. `Alabama` will remain in the system if it is associated with another item id.

To completely remove a tag from an item simply erase it (delete all its characters) and `Update`.

## Examples

The testing suite demonstrates all useful functionality. 

An example of how to use the `select2` jQuery plugin for doing autocomplete/search against an `Express` server can be found in the `examples/select2` folder:
```
examples/select2> node express.js

Go to localhost:8081
```

## TODO

- when items_lookup action clears all tags on item, item remains as <item> : [] in hash (empty array). Make this behavior an option? Is it redis style to remove keys that have no values? Leave it up to the implementer? Value of leaving empty array?
- search option - max # returned
- Be able to copy tag references into another tag. The goal is to be able to take all the assignations that "books" might have (which ids it is associated with) and assign the new tag with those same associations.
- Tests: ensure we have clean separation using namespaces by creating namespace and validating that operations never leak.
- Autocomplete: complete addition of "seed" tags (not associated with any item), if possible. Is this too corrupting? Means that some items in autocomplete are unassociated tags (no item association). Is that ok? Problems?
- Autocomplete: more tests
- Update docs for admin, with pictures etc.
- some api methods not documented, or incorrectly documented. Finish.
- inflate should pipeline, as well as chunk the updates (will likely be very many, even hundreds of thousands).
