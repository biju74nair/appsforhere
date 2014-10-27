'use strict';

var logger = require('pine')();
var passport = require('passport');
var PayPalUser = require('../models/payPalUser');
var PayPalDelegatedUser = require('../models/payPalDelegatedUser');
var appUtils = require('appUtils');
var crypto = require('crypto');
var cardinfo = require('../lib/cardinfo');
var util = require('util');
var Vault = require('../models/vault');
var VaultSession = require('../models/vaultSession');

// Create a token generator with the default settings:
var randtoken = require('rand-token').generator({
    chars: 'abcdefghijklmnpqrstuvwxyz0123456789'
});

var jsTemplate = require('fs').readFileSync('.build/js/vault/client.js').toString();

module.exports = function (router) {

    var saveRole = appUtils.hasRoles(appUtils.ROLES.SaveVault);

    router
        .use(appUtils.domain);

    router.route('/')
        .all(appUtils.loginWithQueryParams)
        .all(appUtils.auth)
        .all(saveRole)
        .get(function (req, res) {
            var model = {
                host: req.headers.host,
                hash: codeForId(req.user.profileId),
                code: 'CODE_HERE'
            };
            if (req.query.kiosk) {
                model.kiosk = true;
            }
            res.render('vault/index', model);
        });

    router.route('/session')
        .all(appUtils.loginWithQueryParams)
        .all(appUtils.auth)
        .all(saveRole)
        .get(function (req, res) {
           VaultSession.createSession(req, function (e,info) {
               if (e) {
                   res.status(500).json({
                       error: e.toString()
                   });
               } else {
                   res.json({
                       id: info.session.id.toString(),
                       serverSecret: info.key,
                       publicKey: info.session.publicKey
                   });
               }
           });
        });

    router.route('/session/:id')
        .get(function (req, res) {
            VaultSession.getSession(req.params.id, function (err, doc) {
               res.send(jsTemplate.replace('{{PUBLICKEY}}', doc.publicKey));
            });
        })
        .delete(function (req, res) {
            VaultSession.findOneAndRemove({id:req.params.id}, function (e) {
               if (e) {
                   res.status(500).json({error: e.toString()});
               } else {
                   res.json({status:'deleted'});
               }
            });
        });

    router.post('/session/complete/:id', appUtils.payPalAccess, function (req, res) {
        VaultSession.decryptPayload(req, function (err, payload) {
            if (err) {
                logger.error('Completion failed: %s\n%s', err.message, err.stack);
                res.status(500).json({error: err.toString()});
                return;
            }
            var json;
            try {
                json = JSON.parse(payload);
            } catch (x) {
                logger.error('JSON parsing failed: %s', x.message);
                res.status(500).json({error: x.toString()});
                return;
            }
            if (!json || !translateAndValidate(json)) {
                logger.error('Invalid card JSON received');
                res.status(500).json({error: 'Invalid card JSON received.'});
                return;
            }
            vaultIt(req, json, function (err,info) {
                if (err) {
                    logger.error('Vaulting failed: %s\n%s', err.message, err.stack);
                    res.status(500).json({error: err.toString()});
                } else {
                    delete info.links; // just too verbose to be useful IMHO
                    res.json(info);
                }
            });
        });
    });

    router.get('/test', function (req, res) {
       res.render('vault/test');
    });

    router.get('/pickup/:verification/:code', function (req, res, next) {
        Vault.findOne({short_code: req.params.code}, function (e, d) {
            if (e) {
                next(e);
            } else if (!d) {
                res.status(404).json({
                    error: 'Code not found'
                });
            } else {
                var v = codeForId(d.profileId);
                if (v === req.params.verification) {
                    res.json({
                        card_id: d.card_id,
                        valid_until: d.valid_until,
                        number: d.number
                    });
                    if (req.query.delete === 'true') {
                        d.remove();
                    }
                } else {
                    res.status(404).json({
                        error: 'Code not found.'
                    });
                }
            }
        });
    });

    router.route('/save')
        .all(appUtils.auth)
        .all(saveRole)
        .post(function (req, res, next) {
            var dateParts = expirationFromString(req.body['card-expiration']);
            var body = {
                number: req.body['card-number'].replace(/[^0-9]/g, ''),
                type: req.body['card-type'],
                expire_month: dateParts.m,
                expire_year: dateParts.y,
                cvv2: req.body['card-cvc']
            };
            vaultIt(req, body, function (err, rz) {
                if (err) {
                    next(err);
                    return;
                }
                saveCode(req, rz, function (err, doc) {
                    var model = {
                        host: req.headers.host,
                        hash: codeForId(req.user.profileId),
                        code: doc.short_code,
                        number: endOf(doc.number, 4)
                    };
                    if (req.body.kiosk) {
                        model.kiosk = true;
                    }
                    res.render('vault/index', model);
                });
            });
        });

    var translationTable = {
        'n': 'number',
        'm': 'expire_month',
        'y': 'expire_year',
        'x': function (json, x) {
            var dateParts = expirationFromString(x);
            json.expire_month = dateParts.m;
            json.expire_year = dateParts.y;
        },
        't': 'type',
        'c': 'cvv2'
    };
    /**
     * Change short-named properties into normal ones for the vault service
     * @param json from the client
     */
    function translateAndValidate(json) {
        for (var k in translationTable) {
            if (json[k]) {
                if (typeof(translationTable[k]) === 'function') {
                    translationTable[k](json, json[k]);
                } else {
                    json[translationTable[k]] = json[k];
                }
                delete json[k];
            }
        }
        ensureType(json);
        return validateCard(json);
    }

    function validateCard(json) {
        if (!json.number || !json.expire_month || !json.expire_year && !json.type) {
            return false;
        }
        return true;
    }

    /**
     * Fill in credit card type from number if not passed
     */
    function ensureType(json) {
        if (!json.type) {
            var info = cardinfo.cardFromNumber(json.number);
            if (info) {
                json.type = info.type;
            }
        }
    }

    function vaultIt(req, cardBody, cb) {
        var url = req.hereApiUrl('credit-card', 'vault');
        req.hereApi().post({
            url: url,
            tokens: req.user,
            json: true,
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify(cardBody)
        }, function (err, rz) {
            if (err) {
                cb(err);
                return;
            }
            if (rz.debug_id) {
                cb(new Error('Card failed: ' + util.inspect(rz)));
                return;
            }
            cb(null, rz);
        });
    }

    function expirationFromString(s) {
        var dateParts = s.split('/');
        var m = parseInt(dateParts[0]);
        var y = parseInt(dateParts[1]);
        if (y < 2000) {
            y += 2000;
        }
        return {
            m: m > 9 ? String(m) : ('0'+String(m)),
            y: String(y)
        };
    }

    function saveCode(req, cardInfo, cb) {
        var short = randtoken.generate(5);
        var doc = new Vault({
            card_id: cardInfo.id,
            short_code: short,
            profileId: req.user.profileId,
            timestamp: new Date(),
            valid_until: cardInfo.valid_until,
            number: cardInfo.number
        });
        doc.save(function (err) {
            if (err && err.code === 11000 &&
                err.err && err.err.indexOf('duplicate') >= 0) {
                if (cardInfo.tries > 20) {
                    cb(err);
                } else {
                    if (cardInfo.tries) {
                        cardInfo.tries++;
                    } else {
                        cardInfo.tries = 1;
                    }
                    saveCode(req, cardInfo, cb);
                }
            } else if (err) {
                cb(err);
            } else {
                cb(null, doc);
            }
        });
    }

    function endOf(str, chars) {
        str = str.replace(new RegExp('[=]+$'), '');
        if (str.length < chars) {
            return str;
        }
        return str.substr(str.length - chars);
    }

    function codeForId(profileId) {
        var shasum = crypto.createHash('sha1');
        shasum.update(profileId);
        shasum.update('saltoftheearth');
        return endOf(shasum.digest('base64'), 8);
    }
};
