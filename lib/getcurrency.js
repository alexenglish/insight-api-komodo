'use strict';

var Common = require('./common');

function GetCurrencyController(node) {
  this.node = node;
  this.common = new Common({log: this.node.log});
  
  // Cache for currency data with 24-hour expiration
  this.currencyCache = {};
  this.CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
}

GetCurrencyController.prototype.show = function(req, res) {
  var self = this;
  var currency = req.params.currency;

  if (!currency) {
    return self.common.handleErrors({
      message: 'Currency name is required',
      code: 1
    }, res);
  }

  // Check cache first
  var cacheKey = currency.toLowerCase(); // Use lowercase for case-insensitive matching
  var now = Date.now();
  var cached = self.currencyCache[cacheKey];
  
  if (cached && (now - cached.timestamp) < self.CACHE_DURATION) {
    // Cache hit and still valid
    self.node.log.info('Returning cached currency data for: ' + currency);
    return self.sendResponse(req, res, cached.data);
  }

  // Cache miss or expired - fetch from blockchain
  self.node.log.info('Fetching currency data from blockchain for: ' + currency);
  this.node.services.bitcoind.getCurrency(currency, function(err, result) {
    if (err) {
      return self.common.handleErrors(err, res);
    }

    // Store in cache
    self.currencyCache[cacheKey] = {
      data: result,
      timestamp: now
    };

    self.sendResponse(req, res, result);
  });
};

GetCurrencyController.prototype.sendResponse = function(req, res, result) {
  // Check if request is from a browser
  var acceptHeader = req.get('Accept') || '';
  if (acceptHeader.includes('text/html')) {
    // Browser request - send formatted HTML with colorful JSON
    var json = JSON.stringify(result, null, 2);
    
    // Escape HTML entities first
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    // Apply syntax highlighting with proper token parsing
    json = json
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?)/g, function(match) {
        var cls = 'string';
        if (/:$/.test(match)) {
          cls = 'key';
          return '<span class="json-key">' + match.replace(/:$/, '') + '</span>:';
        }
        return '<span class="json-string">' + match + '</span>';
      })
      .replace(/\b(true|false)\b/g, '<span class="json-boolean">$1</span>')
      .replace(/\bnull\b/g, '<span class="json-null">null</span>')
      .replace(/\b(-?\d+\.?\d*([eE][+-]?\d+)?)\b/g, '<span class="json-number">$1</span>');
    
    res.set('Content-Type', 'text/html');
    res.send('<html><head><style>' +
      'body{font-family:"Consolas","Monaco","Courier New",monospace;margin:20px;background:#1e1e1e;color:#d4d4d4;font-size:13px;line-height:1.5;}' +
      'pre{white-space:pre-wrap;word-wrap:break-word;margin:0;}' +
      '.json-key{color:#9cdcfe;font-weight:normal;}' +
      '.json-string{color:#ce9178;}' +
      '.json-number{color:#b5cea8;}' +
      '.json-boolean{color:#569cd6;font-weight:bold;}' +
      '.json-null{color:#569cd6;font-style:italic;}' +
      '</style></head><body><pre>' + json + '</pre></body></html>');
  } else {
    // API request - send plain JSON
    res.jsonp(result);
  }
};

// Warm up the cache with common currencies
// COMMENTED OUT: getcurrency functionality is disabled for this release
/*
GetCurrencyController.prototype.warmCache = function() {
  var self = this;
  var commonCurrencies = ['VRSC', 'vETH', 'CHIPS', 'DAI.vETH', 'Bridge.vETH'];
  
  self.node.log.info('Warming up currency cache for common currencies...');
  
  commonCurrencies.forEach(function(currency) {
    self.node.services.bitcoind.getCurrency(currency, function(err, result) {
      if (!err && result) {
        var cacheKey = currency.toLowerCase();
        self.currencyCache[cacheKey] = {
          data: result,
          timestamp: Date.now()
        };
        self.node.log.info('Cached currency data for: ' + currency);
      } else if (err) {
        self.node.log.warn('Failed to warm cache for currency: ' + currency);
      }
    });
  });
};
*/

module.exports = GetCurrencyController;