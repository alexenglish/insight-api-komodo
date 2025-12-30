'use strict';

var Writable = require('stream').Writable;
var bodyParser = require('body-parser');
var compression = require('compression');
var BaseService = require('./service');
var inherits = require('util').inherits;
var BlockController = require('./blocks');
var TxController = require('./transactions');
var AddressController = require('./addresses');
var ChartController = require('./charts');
var StatusController = require('./status');
var MessagesController = require('./messages');
var UtilsController = require('./utils');
var CurrencyController = require('./currency');
var GetCurrencyController = require('./getcurrency');
var RateLimiter = require('./ratelimiter');
var morgan = require('morgan');
var bitcore = require('bitcore-lib-komodo');
var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;
var Transaction = bitcore.Transaction;
var EventEmitter = require('events').EventEmitter;

/**
 * A service for Bitcore to enable HTTP routes to query information about the blockchain.
 *
 * @param {Object} options
 * @param {Boolean} options.enableCache - This will enable cache-control headers
 * @param {Number} options.cacheShortSeconds - The time to cache short lived cache responses.
 * @param {Number} options.cacheLongSeconds - The time to cache long lived cache responses.
 * @param {String} options.routePrefix - The URL route prefix
 */
var InsightAPI = function(options) {
  BaseService.call(this, options);

  // in minutes
  this.currencyRefresh = options.currencyRefresh || CurrencyController.DEFAULT_CURRENCY_DELAY;

  this.subscriptions = {
    inv: []
  };

  if (!_.isUndefined(options.enableCache)) {
    $.checkArgument(_.isBoolean(options.enableCache));
    this.enableCache = options.enableCache;
  }
  this.cacheShortSeconds = options.cacheShortSeconds;
  this.cacheLongSeconds = options.cacheLongSeconds;

  this.rateLimiterOptions = options.rateLimiterOptions;
  this.disableRateLimiter = options.disableRateLimiter;

  this.blockSummaryCacheSize = options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE;
  this.blockCacheSize = options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE;

  if (!_.isUndefined(options.routePrefix)) {
    this.routePrefix = options.routePrefix;
  } else {
    this.routePrefix = this.name;
  }

  this.txController = new TxController(this.node);
};

InsightAPI.dependencies = ['bitcoind', 'web'];

inherits(InsightAPI, BaseService);

InsightAPI.prototype.cache = function(maxAge) {
  var self = this;
  return function(req, res, next) {
    if (self.enableCache) {
      res.header('Cache-Control', 'public, max-age=' + maxAge);
    }
    next();
  };
};

InsightAPI.prototype.cacheShort = function() {
  var seconds = this.cacheShortSeconds || 30; // thirty seconds
  return this.cache(seconds);
};

InsightAPI.prototype.cacheLong = function() {
  var seconds = this.cacheLongSeconds || 86400; // one day
  return this.cache(seconds);
};

InsightAPI.prototype.getRoutePrefix = function() {
  return this.routePrefix;
};

InsightAPI.prototype.getAddressCompat = function(req, res) {
  var self = this;
  var options = {
    noTxList: parseInt(req.query.noTxList)
  };

  if (req.query.from && req.query.to) {
    options.from = parseInt(req.query.from);
    options.to = parseInt(req.query.to);
  }

  this.node.getAddressSummary(req.addr, options, function(err, summary) {
    if(err) {
      return res.status(503).jsonp({
        error: 'Error retrieving address information'
      });
    }

    var transformed = {
      addrStr: req.addr,
      balance: summary.balance / 1e8,
      balanceSat: summary.balance,
      totalReceived: summary.totalReceived / 1e8,
      totalReceivedSat: summary.totalReceived,
      totalSent: summary.totalSpent / 1e8,
      totalSentSat: summary.totalSpent,
      unconfirmedBalance: summary.unconfirmedBalance / 1e8,
      unconfirmedBalanceSat: summary.unconfirmedBalance,
      unconfirmedTxApperances: summary.unconfirmedAppearances,
      txApperances: summary.appearances,
      transactions: summary.txids,
      currencybalances: summary.currencybalances,
      // Add duplicate keys for backwards compatibility
      address: req.addr,
      sent: summary.totalSpent / 1e8,
      received: summary.totalReceived / 1e8
    };

    res.jsonp(transformed);
  });
};

InsightAPI.prototype.start = function(callback) {
  this.node.services.bitcoind.on('tx', this.transactionEventHandler.bind(this));
  this.node.services.bitcoind.on('block', this.blockEventHandler.bind(this));
  setImmediate(callback);
};

InsightAPI.prototype.createLogInfoStream = function() {
  var self = this;

  function Log(options) {
    Writable.call(this, options);
  }
  inherits(Log, Writable);

  Log.prototype._write = function (chunk, enc, callback) {
    self.node.log.info(chunk.slice(0, chunk.length - 1)); // remove new line and pass to logger
    callback();
  };
  var stream = new Log();

  return stream;
};

InsightAPI.prototype.getRemoteAddress = function(req) {
  if (req.headers['cf-connecting-ip']) {
    return req.headers['cf-connecting-ip'];
  }
  return req.socket.remoteAddress;
};

InsightAPI.prototype._getRateLimiter = function() {
  var rateLimiterOptions = _.isUndefined(this.rateLimiterOptions) ? {} : _.clone(this.rateLimiterOptions);
  rateLimiterOptions.node = this.node;
  var limiter = new RateLimiter(rateLimiterOptions);
  return limiter;
};

InsightAPI.prototype.setupRoutes = function(app, express) {

  var self = this;

  //Enable rate limiter
  if (!this.disableRateLimiter) {
    var limiter = this._getRateLimiter();
    app.use(limiter.middleware());
  }

  //Setup logging
  morgan.token('remote-forward-addr', function(req){
    return self.getRemoteAddress(req);
  });
  var logFormat = ':remote-forward-addr ":method :url" :status :res[content-length] :response-time ":user-agent" ';
  var logStream = this.createLogInfoStream();
  app.use(morgan(logFormat, {stream: logStream}));

  //Enable compression
  app.use(compression());

  //Enable urlencoded data
  app.use(bodyParser.urlencoded({extended: true}));

  //Enable CORS
  app.use(function(req, res, next) {

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Content-Length, Cache-Control, cf-connecting-ip');

    var method = req.method && req.method.toUpperCase && req.method.toUpperCase();

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
    } else {
      next();
    }
  });

  // Create a router for the routes that will be mounted at both prefixes
  var router = express ? express.Router() : require('express').Router();

  //Block routes
  var blockOptions = {
    node: this.node,
    blockSummaryCacheSize: this.blockSummaryCacheSize,
    blockCacheSize: this.blockCacheSize
  };
  var blocks = new BlockController(blockOptions);
  router.get('/blocks', this.cacheShort(), blocks.list.bind(blocks));

  router.get('/block/:blockHash', this.cacheShort(), blocks.checkBlockHash.bind(blocks), blocks.show.bind(blocks));
  router.param('blockHash', blocks.block.bind(blocks));

  router.get('/rawblock/:blockHash', this.cacheLong(), blocks.checkBlockHash.bind(blocks), blocks.showRaw.bind(blocks));
  router.param('blockHash', blocks.rawBlock.bind(blocks));

  router.get('/detailedblock/:blockHash', this.cacheShort(), blocks.checkBlockHash.bind(blocks), blocks.showDetailed.bind(blocks));
  router.param('blockHash', blocks.detailedBlock.bind(blocks));

  router.get('/block-index/:height', this.cacheShort(), blocks.blockIndex.bind(blocks));
  router.param('height', blocks.blockIndex.bind(blocks));

  // Transaction routes
  var transactions = new TxController(this.node);
  router.get('/tx/:txid', this.cacheShort(), transactions.show.bind(transactions));
  router.param('txid', transactions.transaction.bind(transactions));
  router.get('/txs', this.cacheShort(), transactions.list.bind(transactions));
  router.post('/tx/send', transactions.send.bind(transactions));

  // Raw Routes
  router.get('/rawtx/:txid', this.cacheLong(), transactions.showRaw.bind(transactions));
  router.param('txid', transactions.rawTransaction.bind(transactions));

  // Detailed (untransformed) transaction route
  router.get('/detailedtx/:txid', this.cacheShort(), transactions.showDetailed.bind(transactions));
  router.param('txid', transactions.detailedTransaction.bind(transactions));

  // Address routes
  var addresses = new AddressController(this.node);
  router.get('/protocol-addresses', this.cacheLong(), addresses.getProtocolAddresses.bind(addresses));
  router.get('/addr/:addr', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.show.bind(addresses));
  router.get('/addr/:addr/utxo', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.utxo.bind(addresses));
  router.get('/addrs/:addrs/utxo', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multiutxo.bind(addresses));
  router.post('/addrs/utxo', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multiutxo.bind(addresses));
  router.get('/addrs/:addrs/txs', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multitxs.bind(addresses));
  router.post('/addrs/txs', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multitxs.bind(addresses));

  // Address property routes
  router.get('/addr/:addr/balance', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.balance.bind(addresses));
  router.get('/addr/:addr/totalReceived', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.totalReceived.bind(addresses));
  router.get('/addr/:addr/totalSent', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.totalSent.bind(addresses));
  router.get('/addr/:addr/unconfirmedBalance', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.unconfirmedBalance.bind(addresses));

  // Chart routes
  var chartOptions = {
    node: this.node,
    blocks: blocks
  };
  var charts = new ChartController(chartOptions);
  router.get('/charts', this.cacheShort(), charts.list.bind(charts));
  router.get('/chart/:chartType', this.cacheShort(), charts.show.bind(charts));
  router.param('chartType', charts.chart.bind(charts));

  // Status route
  var status = new StatusController(this.node);
  router.get('/status', this.cacheShort(), status.show.bind(status));
  router.get('/sync', this.cacheShort(), status.sync.bind(status));
  router.get('/peer', this.cacheShort(), status.peer.bind(status));
  router.get('/version', this.cacheShort(), status.version.bind(status));

  // Address routes
  var messages = new MessagesController(this.node);
  router.get('/messages/verify', messages.verify.bind(messages));
  router.post('/messages/verify', messages.verify.bind(messages));

  // Utils route
  var utils = new UtilsController(this.node);
  router.get('/utils/estimatefee', utils.estimateFee.bind(utils));

  // Currency
  var currency = new CurrencyController({
    node: this.node,
    currencyRefresh: this.currencyRefresh
  });
  router.get('/currency', currency.index.bind(currency));

  // Get Currency (Verus)
 // var getCurrency = new GetCurrencyController(this.node);
 // router.get('/getcurrency/:currency', this.cacheShort(), getCurrency.show.bind(getCurrency));
  
  // Warm up the currency cache on startup
  // COMMENTED OUT: getcurrency functionality is disabled for this release
  /*
  setTimeout(function() {
    getCurrency.warmCache();
  }, 5000); // Wait 5 seconds after startup to warm cache
  */

  //API Exchange and Cointracking website Exposed APIS
  router.get('/coinsupply', this.cacheShort(), status.api_coinsupply.bind(status));
  router.get('/getblockcount', this.cacheShort(), status.api_getblockcount.bind(status));
  router.get('/getblock', this.cacheShort(), status.api_getblock.bind(status));
  router.get('/getblockhash', this.cacheShort(), status.api_getblockhash.bind(status));
  router.get('/getdifficulty', this.cacheShort(), status.api_getdifficulty.bind(status));
  router.get('/getnetworkhashps', this.cacheShort(), status.api_getnetworkhashps.bind(status));
  router.get('/getpeerinfo', this.cacheShort(), status.api_getpeerinfo.bind(status));
  
  // Custom API endpoints for backwards compatibility
  router.get('/getbalance/:addr', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.balance.bind(addresses));
  router.get('/getaddress/:addr', this.cacheShort(), addresses.checkAddr.bind(addresses), this.getAddressCompat.bind(this));
  router.get('/getmoneysupply', this.cacheShort(), status.api_getmoneysupply.bind(status));
  router.get('/getrawtransaction', this.cacheShort(), transactions.getRawTransactionCompat.bind(transactions));

  // Mount the router at the current app (which will be at /api via the web service)
  app.use('/', router);
  
  // Also mount at /ext for backwards compatibility
  // We need to access the parent/main Express app to add this additional route
  // The 'app' parameter here is a sub-app mounted at /api by the web service
  if (this.node && this.node.services && this.node.services.web && this.node.services.web.app) {
    this.node.services.web.app.use('/ext', router);
  }

  // Not Found
  app.use(function(req, res) {
    res.status(404).jsonp({
      status: 404,
      url: req.originalUrl,
      error: 'Not found'
    });
  });

};

InsightAPI.prototype.getPublishEvents = function() {
  return [
    {
      name: 'inv',
      scope: this,
      subscribe: this.subscribe.bind(this),
      unsubscribe: this.unsubscribe.bind(this),
      extraEvents: ['tx', 'block']
    }
  ];
};

InsightAPI.prototype.blockEventHandler = function(hashBuffer) {
  // Notify inv subscribers
  for (var i = 0; i < this.subscriptions.inv.length; i++) {
    this.subscriptions.inv[i].emit('block', hashBuffer.toString('hex'));
  }
};
InsightAPI.prototype.transactionEventHandler = function(txBuffer) {
  /* fix crash on mailformed zmq reply, like "7261777478" in data */
  try {
    var tx = new Transaction().fromBuffer(txBuffer);
  } catch (error) {
    this.node.log.error(error + ' - ' + txBuffer.toString('hex'));
    var tx = new Transaction().fromBuffer(Buffer.from("0400008085202f89000000000000000000000000000000000000000000", "hex"));
  }

  var result = this.txController.transformInvTransaction(tx);

  for (var i = 0; i < this.subscriptions.inv.length; i++) {
    this.subscriptions.inv[i].emit('tx', result);
  }
};

InsightAPI.prototype.subscribe = function(emitter) {
  $.checkArgument(emitter instanceof EventEmitter, 'First argument is expected to be an EventEmitter');

  var emitters = this.subscriptions.inv;
  var index = emitters.indexOf(emitter);
  if(index === -1) {
    emitters.push(emitter);
  }
};

InsightAPI.prototype.unsubscribe = function(emitter) {
  $.checkArgument(emitter instanceof EventEmitter, 'First argument is expected to be an EventEmitter');

  var emitters = this.subscriptions.inv;
  var index = emitters.indexOf(emitter);
  if(index > -1) {
    emitters.splice(index, 1);
  }
};

module.exports = InsightAPI;
