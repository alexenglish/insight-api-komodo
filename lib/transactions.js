'use strict';

var bitcore = require('bitcore-lib-komodo');
var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;
var Common = require('./common');
var async = require('async');
var fs = require('fs');
var path = require('path');

var MAXINT = 0xffffffff; // Math.pow(2, 32) - 1;

// Load protocol addresses from JSON file
var PROTOCOL_ADDRESSES_DATA = {};
try {
  var protocolAddressesPath = path.join(__dirname, 'protocol-addresses.json');
  var protocolData = JSON.parse(fs.readFileSync(protocolAddressesPath, 'utf8'));
  PROTOCOL_ADDRESSES_DATA = protocolData.protocolAddresses;
} catch (e) {
  console.error('Error loading protocol addresses:', e.message);
}

function TxController(node) {
  this.node = node;
  this.common = new Common({log: this.node.log});
  // Cache for i-address to friendly name mappings (never expires)
  this.identityNameCache = {};
}

// Helper function to get friendly name from i-address
TxController.prototype.getIdentityFriendlyName = function(iAddress, callback) {
  var self = this;
  
  // Check cache first
  if (self.identityNameCache[iAddress]) {
    return callback(null, self.identityNameCache[iAddress]);
  }
  
  // Call getidentity RPC
  self.node.services.bitcoind.getIdentity(iAddress, function(err, identity) {
    if (err) {
      console.error('Error getting identity for ' + iAddress + ':', err.message);
      return callback(null, iAddress); // Fallback to i-address
    }
    
    var friendlyName = iAddress; // Default fallback
    
    // Extract friendly name from identityinfo
    if (identity && identity.identityinfo && identity.identityinfo.friendlyname) {
      friendlyName = identity.identityinfo.friendlyname;
      // Remove trailing @ symbol if present
      if (friendlyName.endsWith('@')) {
        friendlyName = friendlyName.slice(0, -1);
      }
      // Remove .VRSC suffix if present
      if (friendlyName.endsWith('.VRSC')) {
        friendlyName = friendlyName.slice(0, -5);
      }
    } else if (identity && identity.identity && identity.identity.name) {
      // Fallback to identity.name if friendlyname not available
      friendlyName = identity.identity.name;
    }
    
    // Cache the result permanently
    self.identityNameCache[iAddress] = friendlyName;
    
    callback(null, friendlyName);
  });
};

TxController.prototype.show = function(req, res) {
  if (req.transaction) {
    res.jsonp(req.transaction);
  }
};

/**
 * Find transaction by hash ...
 */
TxController.prototype.transaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getDetailedTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    self.transformTransaction(transaction, function(err, transformedTransaction) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      req.transaction = transformedTransaction;
      next();
    });

  });
};

TxController.prototype.transformTransaction = function(transaction, options, callback) {
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }
  $.checkArgument(_.isFunction(callback));

  var confirmations = 0;
  if(transaction.height >= 0) {
    confirmations = this.node.services.bitcoind.height - transaction.height + 1;
  }

  var transformed = {
    txid: transaction.hash,
    version: transaction.version,
    locktime: transaction.locktime
  };

  if(transaction.coinbase) {
    transformed.vin = [
      {
        coinbase: transaction.inputs[0].script,
        sequence: transaction.inputs[0].sequence,
        n: 0
      }
    ];
  } else {
    transformed.vin = transaction.inputs.map(this.transformInput.bind(this, options));
  }

  transformed.vout = transaction.outputs.map(this.transformOutput.bind(this, options));

  // After mapping outputs, resolve i-addresses in crosschainimport valuein and decode fee pool scripts
  var self = this;
  var iAddressesToResolve = [];
  var scriptsToDecodeIndices = [];
  
  // Collect all i-addresses from crosschainimport valuein and fee pool outputs needing script decode
  transformed.vout.forEach(function(vout, idx) {
    if (vout.crosschainimport && vout.crosschainimport.valuein) {
      Object.keys(vout.crosschainimport.valuein).forEach(function(iAddress) {
        if (iAddress.startsWith('i') && iAddressesToResolve.indexOf(iAddress) === -1) {
          iAddressesToResolve.push(iAddress);
        }
      });
    }
    if (vout.needsScriptDecode) {
      scriptsToDecodeIndices.push(idx);
    }
  });
  
  // Process script decoding (fee pools and accepted notarizations) and i-address resolution in parallel
  async.parallel({
    // Decode scripts (fee pools and accepted notarizations)
    scriptsDecoded: function(cb) {
      if (scriptsToDecodeIndices.length === 0) {
        return cb(null, []);
      }
      async.map(scriptsToDecodeIndices, function(voutIdx, callback) {
        var vout = transformed.vout[voutIdx];
        // Call decodeScript through the RPC client
        self.node.services.bitcoind.client.decodeScript(vout.scriptHex, function(err, decoded) {
          if (err) {
            console.error('Error decoding script:', err.message);
            return callback(null, {idx: voutIdx, decoded: null, type: vout.scriptDecodeType});
          }
          callback(null, {idx: voutIdx, decoded: decoded.result, type: vout.scriptDecodeType});
        });
      }, cb);
    },
    // Resolve i-addresses
    namesResolved: function(cb) {
      if (iAddressesToResolve.length === 0) {
        return cb(null, []);
      }
      async.map(iAddressesToResolve, function(iAddress, callback) {
        self.getIdentityFriendlyName(iAddress, function(err, friendlyName) {
          callback(null, {iAddress: iAddress, friendlyName: friendlyName});
        });
      }, cb);
    }
  }, function(err, results) {
    // Process decoded scripts (fee pools and accepted notarizations)
    if (results.scriptsDecoded && results.scriptsDecoded.length > 0) {
      results.scriptsDecoded.forEach(function(item) {
        var vout = transformed.vout[item.idx];
        
        // Process fee pool
        if (item.type === 'feepool' && item.decoded && item.decoded.feepool && item.decoded.feepool.currencyvalues) {
          vout.feepool = item.decoded.feepool;
          // Collect i-addresses from fee pool currency values for name resolution
          Object.keys(vout.feepool.currencyvalues).forEach(function(iAddress) {
            if (iAddress.startsWith('i') && iAddressesToResolve.indexOf(iAddress) === -1) {
              iAddressesToResolve.push(iAddress);
            }
          });
        }
        
        // Process accepted notarization
        if (item.type === 'acceptednotarization' && item.decoded && item.decoded.acceptednotarization) {
          vout.acceptednotarization = item.decoded.acceptednotarization;
          // Collect currencyid i-address for name resolution
          if (vout.acceptednotarization.currencyid && vout.acceptednotarization.currencyid.startsWith('i')) {
            if (iAddressesToResolve.indexOf(vout.acceptednotarization.currencyid) === -1) {
              iAddressesToResolve.push(vout.acceptednotarization.currencyid);
            }
          }
        }
        
        // Process OP_RETURN with P2SH
        if (item.type === 'opreturn' && item.decoded && item.decoded.p2sh) {
          vout.p2shAddress = item.decoded.p2sh;
          vout.isP2SH = true;
        }
      });
      
      // If we found new i-addresses in fee pool, resolve them now
      if (iAddressesToResolve.length > results.namesResolved.length) {
        var newAddresses = iAddressesToResolve.slice(results.namesResolved.length);
        async.map(newAddresses, function(iAddress, callback) {
          self.getIdentityFriendlyName(iAddress, function(err, friendlyName) {
            callback(null, {iAddress: iAddress, friendlyName: friendlyName});
          });
        }, function(err, newResults) {
          results.namesResolved = results.namesResolved.concat(newResults);
          applyNamesAndContinue();
        });
      } else {
        applyNamesAndContinue();
      }
    } else {
      applyNamesAndContinue();
    }
    
    function applyNamesAndContinue() {
      // Create name mapping object
      var nameMapping = {};
      results.namesResolved.forEach(function(result) {
        nameMapping[result.iAddress] = result.friendlyName;
      });
      
      // Apply friendly names to crosschainimport outputs
      transformed.vout.forEach(function(vout) {
        if (vout.crosschainimport && vout.crosschainimport.valuein) {
          vout.crosschainimport.valueinFriendly = {};
          Object.keys(vout.crosschainimport.valuein).forEach(function(iAddress) {
            var friendlyName = nameMapping[iAddress] || iAddress;
            vout.crosschainimport.valueinFriendly[friendlyName] = vout.crosschainimport.valuein[iAddress];
          });
        }
        
        // Apply friendly names to fee pool outputs
        if (vout.feepool && vout.feepool.currencyvalues) {
          vout.feepool.currencyvaluesFriendly = {};
          Object.keys(vout.feepool.currencyvalues).forEach(function(iAddress) {
            var friendlyName = nameMapping[iAddress] || iAddress;
            vout.feepool.currencyvaluesFriendly[friendlyName] = vout.feepool.currencyvalues[iAddress];
          });
        }
        
        // Apply friendly name to accepted notarization currency ID
        if (vout.acceptednotarization && vout.acceptednotarization.currencyid) {
          var currencyId = vout.acceptednotarization.currencyid;
          vout.acceptednotarization.currencyNameFriendly = nameMapping[currencyId] || currencyId;
        }
      });
      
      continueTransform();
    }
  });
  
  function continueTransform() {
    if (transformed.version >= 2) {
      transformed.vjoinsplit = transaction.joinSplits.map(self.transformJoinSplit.bind(self, options));
    }

    transformed.blockhash = transaction.blockHash;
    transformed.blockheight = transaction.height;
    transformed.confirmations = confirmations;
    // TODO consider mempool txs with receivedTime?
    var time = transaction.blockTimestamp ? transaction.blockTimestamp : Math.round(Date.now() / 1000);
    transformed.time = time;
    if (transformed.confirmations) {
      transformed.blocktime = transformed.time;
    }

    if(transaction.coinbase) {
      transformed.isCoinBase = true;
    }

    transformed.valueOut = transaction.outputSatoshis / 1e8;
    transformed.size = transaction.hex.length / 2; // in bytes
    if (!transaction.coinbase) {
      transformed.valueIn = transaction.inputSatoshis / 1e8;
      transformed.fees = transaction.feeSatoshis / 1e8;
    }

    // Overwinter START
    transformed.fOverwintered = transaction.fOverwintered;
    if (transaction.fOverwintered) {
      transformed.nVersionGroupId = transaction.nVersionGroupId;
      transformed.nExpiryHeight = transaction.nExpiryHeight;
    }
    // Overwinter END

    // Sapling START
    if (transaction.fOverwintered && transaction.version >= 4) {
      transformed.valueBalance = transaction.valueBalance;
      transformed.spendDescs = transaction.spendDescs;
      transformed.outputDescs = transaction.outputDescs;
      if (transaction.bindingSig) {
        transformed.bindingSig = transaction.bindingSig;
      }
    }
    // Sapling END

    callback(null, transformed);
  }
};

TxController.prototype.transformInput = function(options, input, index) {
  // Input scripts are validated and can be assumed to be valid
  var transformed = {
    txid: input.prevTxId,
    vout: input.outputIndex,
    sequence: input.sequence,
    n: index
  };

  if (!options.noScriptSig) {
    transformed.scriptSig = {
      hex: input.script
    };
    if (!options.noAsm) {
      transformed.scriptSig.asm = input.scriptAsm;
    }
  }

  transformed.addr = input.address ? input.address : (input.addresses ? input.addresses.join(',') : null);
  transformed.valueSat = input.satoshis;
  transformed.value = input.satoshis / 1e8;
  transformed.doubleSpentTxID = null; // TODO
  //transformed.isConfirmed = null; // TODO
  //transformed.confirmations = null; // TODO
  //transformed.unconfirmedInput = null; // TODO

  return transformed;
};

TxController.prototype.transformOutput = function(options, output, index) {
  var transformed = {
    value: (output.satoshis / 1e8).toFixed(8),
    n: index,
    scriptPubKey: {
      hex: output.script
    }
  };

  // Only add these fields if they have values
  if (output.identityprimary) {
    transformed.identityprimary = output.identityprimary;
  }
  if (output.currencydefinition) {
    transformed.currencydefinition = output.currencydefinition;
  }
  if (output.script_reserve_balance) {
    transformed.script_reserve_balance = output.script_reserve_balance;
  }
  if (output.addresses) {
    transformed.addresses = output.addresses;
  }
  if (output.finalizeNotarization) {
    transformed.finalizeNotarization = output.finalizeNotarization;
  }

  // Check if this is an OP_RETURN output that might have P2SH
  if (output.scriptAsm && output.scriptAsm.indexOf('OP_RETURN') === 0 && output.script && !output.address) {
    transformed.needsScriptDecode = true;
    transformed.scriptHex = output.script;
    transformed.scriptDecodeType = 'opreturn';
  }

  // Check if this output uses a protocol address
  var outputAddress = output.address || (output.addresses && output.addresses[0]);
  if (outputAddress && PROTOCOL_ADDRESSES_DATA[outputAddress]) {
    transformed.isProtocolAddress = true;
    transformed.protocolName = PROTOCOL_ADDRESSES_DATA[outputAddress].name;
    transformed.protocolDescription = PROTOCOL_ADDRESSES_DATA[outputAddress].description;
    transformed.protocolColor = PROTOCOL_ADDRESSES_DATA[outputAddress].color;
    transformed.protocolIcon = PROTOCOL_ADDRESSES_DATA[outputAddress].icon;
    transformed.originalProtocolAddress = outputAddress;
    
    // Check if this is a fee pool output - need to decode script to get actual values
    if (outputAddress === 'RQ55dLQ7uGnLx8scXfkaFV6QS6qVBGyxAG' && output.script) {
      transformed.needsScriptDecode = true;
      transformed.scriptHex = output.script;
      transformed.scriptDecodeType = 'feepool';
    }
    
    // Check if this is an accepted notarization output - need to decode script to show proposer and currency
    if (outputAddress === 'RDTq9qn1Lthv7fvsdbWz36mGp8HK9XaruZ' && output.script) {
      transformed.needsScriptDecode = true;
      transformed.scriptHex = output.script;
      transformed.scriptDecodeType = 'acceptednotarization';
    }
  }

  if(output.crosschainimport) {
    transformed.crosschainimport = output.crosschainimport;
    transformed.other_commitment = {'crosschainimport': true};
  }
  if(output.crosschainexport)
    transformed.other_commitment = {'crosschainexport': true};;
  if(output.identitycommitment != null)
    transformed.other_commitment = output.identitycommitment;
  if(output.reservetransfer) {
    transformed.reservetransfer = output.reservetransfer;
    // Check if this is a cross-chain reserve transfer with a destination
    if(output.reservetransfer.destination && output.reservetransfer.destination.address) {
      transformed.actualDestination = output.reservetransfer.destination.address;
      // Check if it's to Ethereum
      if(output.reservetransfer.crosssystem && 
         output.reservetransfer.exportto === 'i9nwxtKuVYX4MSbeULLiK2ttVi6rUEhh4X') {
        transformed.isCrossChainToEthereum = true;
      }
    }
    transformed.other_commitment = {'reservetransfer': true};
  }
  if(output.pbaasNotarization)
    transformed.other_commitment = {'pbaasNotarization': true};;
  if (!options.noAsm) {
    transformed.scriptPubKey.asm = output.scriptAsm;
  }


  if (!options.noSpent) {
    transformed.spentTxId = output.spentTxId || null;
    transformed.spentIndex = _.isUndefined(output.spentIndex) ? null : output.spentIndex;
    transformed.spentHeight = output.spentHeight || null;
  }

  if (output.address) {
    transformed.scriptPubKey.addresses = [output.address];
    var address = bitcore.Address(output.address); //TODO return type from bitcore-node
    transformed.scriptPubKey.type = address.type;
  }
  return transformed;
};

TxController.prototype.transformJoinSplit = function(options, jsdesc, index) {
  var transformed = {
    vpub_old: (jsdesc.oldZatoshis / 1e8).toFixed(8),
    vpub_new: (jsdesc.newZatoshis / 1e8).toFixed(8),
    n: index,
  };
  return transformed;
};

TxController.prototype.transformInvTransaction = function(transaction) {
  var self = this;

  var valueOut = 0;
  var vout = [];
  for (var i = 0; i < transaction.outputs.length; i++) {
    var output = transaction.outputs[i];
    valueOut += output.satoshis;
    if (output.script) {
      var address = output.script.toAddress(self.node.network);
      if (address) {
        var obj = {};
        obj[address.toString()] = output.satoshis;
        vout.push(obj);
      }
    }
  }

  var isRBF = _.any(_.pluck(transaction.inputs, 'sequenceNumber'), function(seq) {
    return seq < MAXINT - 1;
  });

  var transformed = {
    txid: transaction.hash,
    valueOut: valueOut / 1e8,
    vout: vout,
    isRBF: isRBF,
  };

  return transformed;
};

TxController.prototype.rawTransaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    req.rawTransaction = {
      'rawtx': transaction.toBuffer().toString('hex')
    };

    next();
  });
};

TxController.prototype.showRaw = function(req, res) {
  if (req.rawTransaction) {
    res.jsonp(req.rawTransaction);
  }
};

TxController.prototype.detailedTransaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getDetailedTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    req.detailedTransaction = transaction;
    next();
  });
};

TxController.prototype.removeNullValues = function(obj) {
  if (Array.isArray(obj)) {
    return obj.map(item => this.removeNullValues(item));
  } else if (obj !== null && typeof obj === 'object') {
    var cleaned = {};
    for (var key in obj) {
      if (obj.hasOwnProperty(key) && obj[key] !== null) {
        cleaned[key] = this.removeNullValues(obj[key]);
      }
    }
    return cleaned;
  }
  return obj;
};

TxController.prototype.showDetailed = function(req, res) {
  if (req.detailedTransaction) {
    // Remove null values from the transaction object
    var cleanedTransaction = this.removeNullValues(req.detailedTransaction);
    
    // Check if request is from a browser
    var acceptHeader = req.get('Accept') || '';
    if (acceptHeader.includes('text/html')) {
      // Browser request - send formatted HTML with colorful JSON
      var json = JSON.stringify(cleanedTransaction, null, 2);
      
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
      res.jsonp(cleanedTransaction);
    }
  }
};

TxController.prototype.getRawTransactionCompat = function(req, res) {
  var self = this;
  var txid = req.query.txid;
  // decrypt parameter is ignored as requested

  if (!txid) {
    return res.status(400).jsonp({
      error: 'txid parameter is required'
    });
  }

  this.node.getDetailedTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    res.jsonp(transaction);
  });
};

TxController.prototype.list = function(req, res) {
  var self = this;

  var blockHash = req.query.block;
  var address = req.query.address;
  var page = parseInt(req.query.pageNum) || 0;
  var pageLength = 10;
  var pagesTotal = 1;

  if(blockHash) {
    self.node.getBlockOverview(blockHash, function(err, block) {
      if(err && err.code === -5) {
        return self.common.handleErrors(null, res);
      } else if(err) {
        return self.common.handleErrors(err, res);
      }

      var totalTxs = block.txids.length;
      var txids;

      if(!_.isUndefined(page)) {
        var start = page * pageLength;
        txids = block.txids.slice(start, start + pageLength);
        pagesTotal = Math.ceil(totalTxs / pageLength);
      } else {
        txids = block.txids;
      }

      async.mapSeries(txids, function(txid, next) {
        self.node.getDetailedTransaction(txid, function(err, transaction) {
          if (err) {
            return next(err);
          }
          self.transformTransaction(transaction, next);
        });
      }, function(err, transformed) {
        if(err) {
          return self.common.handleErrors(err, res);
        }

        res.jsonp({
          pagesTotal: pagesTotal,
          txs: transformed
        });
      });

    });
  } else if(address) {
    var options = {
      from: page * pageLength,
      to: (page + 1) * pageLength
    };

    self.node.getAddressHistory(address, options, function(err, result) {
      if(err) {
        return self.common.handleErrors(err, res);
      }

      var txs = result.items.map(function(info) {
        return info.tx;
      }).filter(function(value, index, self) {
        return self.indexOf(value) === index;
      });

      async.map(
        txs,
        function(tx, next) {
          self.transformTransaction(tx, next);
        },
        function(err, transformed) {
          if (err) {
            return self.common.handleErrors(err, res);
          }
          res.jsonp({
            pagesTotal: Math.ceil(result.totalCount / pageLength),
            txs: transformed
          });
        }
      );
    });
  } else {
    return self.common.handleErrors(new Error('Block hash or address expected'), res);
  }
};

TxController.prototype.send = function(req, res) {
  var self = this;
  this.node.sendTransaction(req.body.rawtx, function(err, txid) {
    if(err) {
      // TODO handle specific errors
      return self.common.handleErrors(err, res);
    }

    res.json({'txid': txid});
  });
};

module.exports = TxController;
