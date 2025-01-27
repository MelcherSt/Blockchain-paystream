var express = require('express');
var router = express.Router();
var fs = require('fs');
var path = require('path');
const url = require('url');
const crypto = require('crypto');
const plugin = require('./plugins.js').xrp.Shop();
const IlpPacket = require('ilp-packet');
const http = require('http');
const base64url = require('base64url');

const frame_costs = 1;
let normalizedCost = 0;
let ledgerInfo;
let account;

let balances = {};
let sharedSecrets = {};
let initFrameName = 'init.mp4';

function sha256 (preimage) {
  return crypto.createHash('sha256').update(preimage).digest()
}

function hmac (secret, input) {
  return crypto.createHmac('sha256', secret).update(input).digest()
}

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Express' });
});

router.get('/video/:encoding/:segment', function(req, res, next) {
	var name = req.params.segment;
	var encoding = req.params.encoding;
	filename = path.join(__dirname, '../video', encoding, name);

	try {
		stats = fs.lstatSync(filename); // throws if path doesn't exist
	} catch (e) {
		res.writeHead(404, {'Content-Type': 'text/plain'});
		res.write('404 Not Found\n');
		res.end();
		return;
	}

	if (stats.isFile()) {
		// make sure the frame is paid for. Init frame is free.
		var paid = false;

		// do checks here
		var clientId = req.header('Pay-Token');

		if (clientId && name != initFrameName) {
			console.log(' @Accepted shared secret from client', clientId, balances);

			secretBuf = sharedSecrets[clientId];

			if (secretBuf) {
				var secret = base64url(secretBuf);

				if (secret) {

					if (balances[secret] && balances[secret] >= frame_costs) {
						paid = true;
						balances[secret] -= frame_costs
						res.setHeader('Pay-Balance', balances[secret].toString())
						res.setHeader('Frame-costs', frame_costs)
					} else {
						console.log('Client\'s balance too low to pay frame');
					}
				}
			}


		} else {
			console.log('Denied shared secret from client', clientId, balances)
		}

		// serve frame?
		if (paid || name === initFrameName) {
			res.writeHead(200, {'Content-Type': 'application/octet-stream'} );
			var fileStream = fs.createReadStream(filename);
			fileStream.pipe(res);
		} else {
			res.status(403).end();
		}
	} else {
		res.status(500).end();
	}
	return;
});

router.get('/login', function(req, res, next) {
  	console.log(`Login Request`)
	if(normalizedCost == 0 && !account && !ledgerInfo) {
		res.writeHead(500, {'Content-Type': 'text/plain'});
		res.write('500 Internal server error\n');
		res.end();
		return;
	}
	const clientId = base64url(crypto.randomBytes(8))
	let sharedSecret = crypto.randomBytes(32)

		console.log(`    -- Client id generated: ${clientId}`)

	sharedSecrets[clientId] = sharedSecret
	if (!balances[base64url(sharedSecret)]) {
		// The client is just establishing its prepaid account, but hasn't paid yet
        balances[base64url(sharedSecret)] = 0
	}
	res.setHeader(`Pay`, `interledger-psk ${frame_costs} ${account}.${clientId} ${base64url(sharedSecret)}`)
	res.setHeader(`Pay-Balance`, balances[base64url(sharedSecret)].toString())
	//res.writeHead(402, {'Content-Type': 'text/plain'});

	console.log(`    -- Request: sharedSecret: ${base64url(sharedSecret)}`)
	res.send({
		cost: frame_costs,
		currency: ledgerInfo.currencyCode,
		account: account,
		clientId: clientId,
		sharedSecret: base64url(sharedSecret),
		balance: balances[base64url(sharedSecret)],
		paymentProviderUri: 'localhost:8000'
	});
	res.end();
});

console.log(`\t== Starting the shop server == `)
console.log(`\tConnecting to an account to accept payments...`)

plugin.connect().then(function () {

	// Get ledger and account information from the plugin
	ledgerInfo = plugin.getInfo()
	account = plugin.getAccount()

	console.log(`    - Connected to ledger: ${ledgerInfo.prefix}`)
	console.log(`    -- Account: ${account}`)
	console.log(`    -- Currency: ${ledgerInfo.currencyCode}`)
	console.log(`    -- CurrencyScale: ${ledgerInfo.currencyScale}`)

	// Convert our cost (10) into the right format given the ledger scale
	normalizedCost = frame_costs / Math.pow(10, parseInt(ledgerInfo.currencyScale))

	console.log(` \tStarting web server to accept requests...`)
	console.log(` \t - Charging ${normalizedCost} ${ledgerInfo.currencyCode} per frame`)

    // Handle incoming payments
	plugin.on('incoming_prepare', function (transfer) {
    	// Generate fulfillment from packet and this client's shared secret
    	const ilpPacket = Buffer.from(transfer.ilp, 'base64')
    	const payment = IlpPacket.deserializeIlpPayment(ilpPacket)
    	const clientId = payment.account.substring(plugin.getAccount().length + 1).split('.')[0]
    	const secret = sharedSecrets[clientId]


	    if (!clientId || !secret) {
	      // We don't have a fulfillment for this condition
	      console.log(`    -- Payment received with an unknown condition: ` +
	                                            `${transfer.executionCondition}`)

	      plugin.rejectIncomingTransfer(transfer.id, {
	        code: 'F05',
	        name: 'Wrong Condition',
	        message: `Unable to fulfill the condition:  ` +
	                                            `${transfer.executionCondition}`,
	        triggered_by: plugin.getAccount(),
	        triggered_at: new Date().toISOString(),
	        forwarded_by: [],
	        additional_info: {}
	      })
	      return
	    }
	    const fulfillmentGenerator = hmac(secret, 'ilp_psk_condition')
	    const fulfillment =  hmac(fulfillmentGenerator, ilpPacket)

	    // Increase this client's balance
	    balances[base64url(secret)] += parseInt(transfer.amount)


	    // The ledger will check if the fulfillment is correct and
	    // if it was submitted before the transfer's rollback timeout
	    plugin.fulfillCondition(transfer.id, base64url(fulfillment))
	      .catch(function () {
	        console.log(`    - Error fulfilling the transfer`)
	      })
	    console.log(`    - Payment complete`)
    
  })
})

module.exports = router;
