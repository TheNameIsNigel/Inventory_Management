const express = require('express');
const db = require('./database');
const path = require('path');
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');
const app = express();

const httpPort = 3000;
const credentials = require('./credentials.json');
const { client_secret, client_id, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const failedLoginAttempts = {};

function checkFailedLogins(req, res, next) {
    const ip = req.ip;

    if (failedLoginAttempts[ip] && failedLoginAttempts[ip].attempts >= 3) {
        const lockoutTime = 300;
        const timeElapsed = (Date.now() - failedLoginAttempts[ip].timestamp) / 1000;

        if (timeElapsed < lockoutTime) {
            const timeLeft = Math.ceil(lockoutTime - timeElapsed);
            return res.status(403).send(`Too many failed login attempts. Try again in ${timeLeft} seconds.`);
        } else {
            delete failedLoginAttempts[ip];
        }
    }

    next();
}

app.use(session({
    secret: 'your-secret-key', // Replace with a strong secret key
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 1 day
    }
}));

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

function isAuthenticated(req, res, next) {
    if (req.session.isAuthenticated) {
        return next();
    }
    res.redirect('/login');
}

function isValidDealerCode(req, res, next) {
    if (req.session.dealerCodeAuthenticated) {
        return next();
    }
    res.redirect('/dealer-login');
}

app.get('/dealer-login', (req, res) => {
    res.render('dealer-login');
});

app.post('/dealer-login', checkFailedLogins, async (req, res) => {
    const { dealerCode } = req.body;
    const ip = req.ip;

    try {
        const dealerCodeRecord = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM dealer_codes WHERE code = ?', [dealerCode], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (dealerCodeRecord) {
            delete failedLoginAttempts[ip];
            req.session.dealerCodeAuthenticated = true;
            req.session.dealerCodeId = dealerCodeRecord.id;
            res.redirect('/');
        } else {
            failedLoginAttempts[ip] = failedLoginAttempts[ip] || { attempts: 0, timestamp: Date.now() };
            failedLoginAttempts[ip].attempts++;
            failedLoginAttempts[ip].timestamp = Date.now();

            const remainingAttempts = 3 - failedLoginAttempts[ip].attempts;
            if (remainingAttempts > 0) {
                res.status(401).send(`Invalid dealer code. ${remainingAttempts} attempts remaining.`);
            } else {
                res.status(403).send('Too many failed login attempts. Try again in 5 minutes.');
            }
        }
    } catch (err) {
        console.error('Error during dealer code check:', err);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/', isValidDealerCode, (req, res) => {
    db.all('SELECT * FROM scans', [], (err, rows) => {
        if (err) {
            throw err;
        }
        res.render('index', { scans: rows, dealerCodeAuthenticated: req.session.dealerCodeAuthenticated });
    });
});

app.post('/scan', (req, res) => {
    const { sku, imei } = req.body;
    const dealerCodeId = req.session.dealerCodeId;

    console.log("SKU:", sku);
    console.log("IMEI:", imei);
    console.log("Dealer Code ID:", dealerCodeId);

    db.run('INSERT INTO scans (sku, imei, dealer_code_id) VALUES (?, ?, ?)', [sku, imei, dealerCodeId], function (err) {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error saving scan to database.');
        }
        console.log(`A row has been inserted with rowid ${this.lastID}`);

        req.session.dealerCodeAuthenticated = false;

        res.json({
            success: true,
            message: 'Scan successful. Please log in again for the next scan.',
            redirect: '/'
        });
    });
});

app.get('/login', (req, res) => {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['profile', 'email']
    });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;

    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        const people = google.people({ version: 'v1', auth: oAuth2Client });
        const { data } = await people.people.get({
            resourceName: 'people/me',
            personFields: 'emailAddresses,names',
        });

        const userEmail = data.emailAddresses && data.emailAddresses.length > 0
            ? data.emailAddresses[0].value
            : null;

        if (userEmail) {
            db.get('SELECT * FROM users WHERE email = ?', [userEmail], (err, user) => {
                if (err) {
                    console.error(err.message);
                    return res.status(500).send('Internal Server Error');
                }

                if (user) {
                    req.session.isAuthenticated = true;
                    req.session.username = user.username;
                    res.redirect('/dashboard');
                } else {
                    res.status(403).send('User not authorized');
                }
            });
        } else {
            res.status(403).send('User not authorized');
        }
    } catch (error) {
        console.error('Error during Google authentication:', error);
        res.status(500).send('Authentication error');
    }
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const scans = await new Promise((resolve, reject) => {
            // Ensure 'scans.sku' is included in the SELECT statement
            db.all('SELECT scans.*, dealer_codes.code AS dealerCode FROM scans LEFT JOIN dealer_codes ON scans.dealer_code_id = dealer_codes.id', [], (err, rows) => {
                if (err) reject(err);
                console.log("Scans from DB:", rows); // Log the data from the database for debugging
                resolve(rows);
            });
        });

        const dealerCodes = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM dealer_codes', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        res.render('dashboard', { scans, username: req.session.username, dealerCodes });
    } catch (err) {
        console.error('Error fetching data from the database:', err.message);
        res.status(500).send('Error retrieving data from the database');
    }
});

app.post('/add-dealer-code', isAuthenticated, (req, res) => {
    const { dealerCode } = req.body;

    db.run('INSERT INTO dealer_codes (code) VALUES (?)', [dealerCode], function(err) {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error adding dealer code.');
        }
        console.log(`Dealer code added with ID ${this.lastID}`);
        res.redirect('/dashboard');
    });
});

app.post('/delete-dealer-code/:id', isAuthenticated, (req, res) => {
    const { id } = req.params;

    db.run('DELETE FROM dealer_codes WHERE id = ?', [id], function(err) {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error deleting dealer code.');
        }
        console.log(`Dealer code with ID ${id} deleted`);
        res.redirect('/dashboard');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).send('Logout failed');
        }
        res.redirect('/login');
    });
});

app.listen(httpPort, () => {
    console.log(`HTTP server running at http://localhost:${httpPort}`);
});