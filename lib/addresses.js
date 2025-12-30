'use strict';

var bitcore = require('bitcore-lib-komodo');
var async = require('async');
var TxController = require('./transactions');
var Common = require('./common');
var fs = require('fs');
var path = require('path');

function AddressController(node) {
  this.node = node;
  this.txController = new TxController(node);
  this.common = new Common({log: this.node.log});
  
  // Load blocked addresses and protocol addresses
  this.blockedAddresses = this.loadBlockedAddresses();
  this.protocolAddresses = this.loadProtocolAddresses();
}

AddressController.prototype.loadBlockedAddresses = function() {
  try {
    var blockedPath = path.join(__dirname, '../../../blocked.json');
    var data = fs.readFileSync(blockedPath, 'utf8');
    var blocked = JSON.parse(data);
    this.node.log.info('Loaded ' + blocked.addresses.length + ' blocked addresses');
    return blocked.addresses;
  } catch (e) {
    this.node.log.warn('Could not load blocked addresses: ' + e.message);
    return [];
  }
};

AddressController.prototype.loadProtocolAddresses = function() {
  try {
    var protocolPath = path.join(__dirname, 'protocol-addresses.json');
    var data = fs.readFileSync(protocolPath, 'utf8');
    var protocol = JSON.parse(data);
    var addresses = Object.keys(protocol.protocolAddresses);
    this.node.log.info('Loaded ' + addresses.length + ' protocol addresses to block from queries');
    return addresses;
  } catch (e) {
    this.node.log.warn('Could not load protocol addresses: ' + e.message);
    return [];
  }
};

AddressController.prototype.isBlocked = function(address) {
  return this.blockedAddresses.indexOf(address) !== -1 || this.protocolAddresses.indexOf(address) !== -1;
};

AddressController.prototype.getProtocolAddresses = function(req, res) {
  res.jsonp({
    addresses: this.protocolAddresses
  });
};

AddressController.prototype.show = function(req, res) {
  var self = this;
  
  // Check if address is blocked
  if (self.isBlocked(req.addr)) {
    self.node.log.warn('Blocked address access attempt: ' + req.addr);
    return res.jsonp({
      addrStr: req.addr,
      balance: 0,
      balanceSat: 0,
      totalReceived: 0,
      totalReceivedSat: 0,
      totalSent: 0,
      totalSentSat: 0,
      unconfirmedBalance: 0,
      unconfirmedBalanceSat: 0,
      unconfirmedTxApperances: 0,
      txApperances: 0,
      transactions: [],
      blocked: true,
      error: 'This address is blocked due to performance issues'
    });
  }
  
  var options = {
    noTxList: parseInt(req.query.noTxList)
  };

  if (req.query.from && req.query.to) {
    options.from = parseInt(req.query.from);
    options.to = parseInt(req.query.to);
  }

  this.getAddressSummary(req.addr, options, function(err, data) {
    if(err) {
      return self.common.handleErrors(err, res);
    }

    // Check if request is from a browser
    var acceptHeader = req.get('Accept') || '';
    if (acceptHeader.includes('text/html')) {
      // Browser request - send formatted HTML with colorful JSON
      var json = JSON.stringify(data, null, 2);
      
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
      res.jsonp(data);
    }
  });
};

AddressController.prototype.balance = function(req, res) {
  this.addressSummarySubQuery(req, res, 'balanceSat');
};

AddressController.prototype.totalReceived = function(req, res) {
  this.addressSummarySubQuery(req, res, 'totalReceivedSat');
};

AddressController.prototype.totalSent = function(req, res) {
  this.addressSummarySubQuery(req, res, 'totalSentSat');
};

AddressController.prototype.unconfirmedBalance = function(req, res) {
  this.addressSummarySubQuery(req, res, 'unconfirmedBalanceSat');
};

AddressController.prototype.addressSummarySubQuery = function(req, res, param) {
  var self = this;
  
  // Check if address is blocked
  if (self.isBlocked(req.addr)) {
    self.node.log.warn('Blocked address access attempt: ' + req.addr);
    return res.jsonp(0);
  }
  
  this.getAddressSummary(req.addr, {}, function(err, data) {
    if(err) {
      return self.common.handleErrors(err, res);
    }

    res.jsonp(data[param]);
  });
};

AddressController.prototype.getAddressSummary = function(address, options, callback) {

  this.node.getAddressSummary(address, options, function(err, summary) {
    if(err) {
      return callback(err);
    }

    var transformed = {
      addrStr: address,
      balance: summary.balance / 1e8,
      balanceSat: summary.balance,
      totalReceived: summary.totalReceived / 1e8,
      totalReceivedSat: summary.totalReceived,
      totalSent: summary.totalSpent / 1e8,
      totalSentSat: summary.totalSpent,
      unconfirmedBalance: summary.unconfirmedBalance / 1e8,
      unconfirmedBalanceSat: summary.unconfirmedBalance,
      unconfirmedTxApperances: summary.unconfirmedAppearances, // misspelling - ew
      txApperances: summary.appearances, // yuck
      transactions: summary.txids,
      identityinfo: summary.identityinfo,
      currencybalance: summary.currencybalance,
      currencybalances: summary.currencybalances,
    };

    callback(null, transformed);
  });
};

AddressController.prototype.getIdentity = function(address, options, callback) {

  this.node.getIdentity(address, options, function(err, summary) {
    if(err) {
      return callback(err);
    }

    var transformed = {
      idname: summary.identity.name
    };

    callback(null, transformed);
  });
};

AddressController.prototype.checkAddr = function(req, res, next) {
  req.addr = req.params.addr;
  this.check(req, res, next, [req.addr]);
};

AddressController.prototype.checkAddrs = function(req, res, next) {
  if(req.body.addrs) {
    req.addrs = req.body.addrs.split(',');
  } else {
    req.addrs = req.params.addrs.split(',');
  }

  this.check(req, res, next, req.addrs);
};

AddressController.prototype.check = function(req, res, next, addresses) {
  var self = this;
  if(!addresses.length || !addresses[0]) {
    return self.common.handleErrors({
      message: 'Must include address',
      code: 1
    }, res);
  }

  for(var i = 0; i < addresses.length; i++) {
    var addr = addresses[i];
    
    // Check if address is blocked (including protocol addresses)
    if (self.isBlocked(addr)) {
      return res.status(400).jsonp({
        error: 'This address cannot be queried as it causes performance issues'
      });
    }
    
    try {
      var a = new bitcore.Address(addr);
    } catch(e) {
      return self.common.handleErrors({
        message: 'Invalid address: ' + e.message,
        code: 1
      }, res);
    }
  }

  next();
};

AddressController.prototype.utxo = function(req, res) {
  var self = this;

  this.node.getAddressUnspentOutputs(req.addr, {}, function(err, utxos) {
    if(err) {
      return self.common.handleErrors(err, res);
    } else if (!utxos.length) {
      return res.jsonp([]);
    }
    res.jsonp(utxos.map(self.transformUtxo.bind(self)));
  });
};

AddressController.prototype.multiutxo = function(req, res) {
  var self = this;
  this.node.getAddressUnspentOutputs(req.addrs, true, function(err, utxos) {
    if(err && err.code === -5) {
      return res.jsonp([]);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    res.jsonp(utxos.map(self.transformUtxo.bind(self)));
  });
};

AddressController.prototype.transformUtxo = function(utxoArg) {
  var utxo = {
    address: utxoArg.address,
    txid: utxoArg.txid,
    vout: utxoArg.outputIndex,
    scriptPubKey: utxoArg.script,
    amount: utxoArg.satoshis / 1e8,
    satoshis: utxoArg.satoshis
  };
  if (utxoArg.height && utxoArg.height > 0) {
    utxo.height = utxoArg.height;
    utxo.confirmations = this.node.services.bitcoind.height - utxoArg.height + 1;
  } else {
    utxo.confirmations = 0;
  }
  if (utxoArg.timestamp) {
    utxo.ts = utxoArg.timestamp;
  }
  return utxo;
};

AddressController.prototype._getTransformOptions = function(req) {
  return {
    noAsm: parseInt(req.query.noAsm) ? true : false,
    noScriptSig: parseInt(req.query.noScriptSig) ? true : false,
    noSpent: parseInt(req.query.noSpent) ? true : false
  };
};

AddressController.prototype.multitxs = function(req, res, next) {
  var self = this;

  var options = {
    from: parseInt(req.query.from) || parseInt(req.body.from) || 0
  };

  options.to = parseInt(req.query.to) || parseInt(req.body.to) || parseInt(options.from) + 10;

  self.node.getAddressHistory(req.addrs, options, function(err, result) {
    if(err) {
      return self.common.handleErrors(err, res);
    }

    var transformOptions = self._getTransformOptions(req);

    self.transformAddressHistoryForMultiTxs(result.items, transformOptions, function(err, items) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      res.jsonp({
        totalItems: result.totalCount,
        from: options.from,
        to: Math.min(options.to, result.totalCount),
        items: items
      });
    });

  });
};

AddressController.prototype.transformAddressHistoryForMultiTxs = function(txinfos, options, callback) {
  var self = this;

  var items = txinfos.map(function(txinfo) {
    return txinfo.tx;
  }).filter(function(value, index, self) {
    return self.indexOf(value) === index;
  });

  async.map(
    items,
    function(item, next) {
      self.txController.transformTransaction(item, options, next);
    },
    callback
  );
};



module.exports = AddressController;
