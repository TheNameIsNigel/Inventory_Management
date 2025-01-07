const express = require('express');
const db = require('./database');
const path = require('path');
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');
const app = express();

const httpPort = 3000;

// Load client secrets from a local file.
const credentials = require('./credentials.json'); // Downloaded from Google Cloud Console
const { client_secret, client_id, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

// In-memory storage for failed login attempts
const failedLoginAttempts = {};

// Middleware to check for blocked IPs
function checkFailedLogins(req, res, next) {
    const ip = req.ip;

    if (failedLoginAttempts[ip] && failedLoginAttempts[ip].attempts >= 3) {
        const lockoutTime = 300; // 5 minutes
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

// Session Configuration
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true when using HTTPS
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Authentication Middleware (for dashboard)
function isAuthenticated(req, res, next) {
    if (req.session.isAuthenticated) {
        return next();
    }
    res.redirect('/login');
}

// Dealer Code Check Middleware
function isValidDealerCode(req, res, next) {
    if (req.session.dealerCodeAuthenticated) {
        return next();
    }
    res.redirect('/dealer-login');
}

// Routes

// Dealer Login Page
app.get('/dealer-login', (req, res) => {
    res.render('dealer-login');
});

// Dealer Login Check
app.post('/dealer-login', checkFailedLogins, async (req, res) => {
    const { dealerCode } = req.body;
    const ip = req.ip;

    try {
        // Check if the dealer code exists in the database
        const dealerCodeRecord = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM dealer_codes WHERE code = ?', [dealerCode], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (dealerCodeRecord) {
            // Reset failed attempts
            delete failedLoginAttempts[ip];

            req.session.dealerCodeAuthenticated = true;
            res.redirect('/');
        } else {
            // Increment failed attempts
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

// Scanner Page (Requires Dealer Code Authentication)
app.get('/', isValidDealerCode, (req, res) => {
    db.all('SELECT * FROM scans', [], (err, rows) => {
        if (err) {
            throw err;
        }
        res.render('index', { scans: rows, dealerCodeAuthenticated: req.session.dealerCodeAuthenticated });
    });
});

// Scan Route (Logs out after each scan)
app.post('/scan', (req, res) => {
    const { type, value } = req.body;

    // Store the scan in the database
    db.run('INSERT INTO scans (type, value) VALUES (?, ?)', [type, value], function (err) {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error saving scan to database.');
        }
        console.log(`A row has been inserted with rowid ${this.lastID}`);

        // Invalidate dealer code authentication
        req.session.dealerCodeAuthenticated = false;

        // Send a JSON response indicating success and the need to log in again
        res.json({ 
            success: true, 
            message: 'Scan successful. Please log in again for the next scan.',
            redirect: '/'
        });
    });
});

// Google Login URL
app.get('/login', (req, res) => {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['profile', 'email'] // Request profile and email scopes
    });
    res.redirect(authUrl);
});

// Google Callback Route
app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;

    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Get user info from Google
        const people = google.people({ version: 'v1', auth: oAuth2Client });
        const { data } = await people.people.get({
            resourceName: 'people/me',
            personFields: 'emailAddresses,names',
        });

        // Check if user's email is allowed
        const userEmail = data.emailAddresses && data.emailAddresses.length > 0
            ? data.emailAddresses[0].value
            : null;

        if (userEmail) {
            // Check if the user's email exists in the database
            db.get('SELECT * FROM users WHERE email = ?', [userEmail], (err, user) => {
                if (err) {
                    console.error(err.message);
                    return res.status(500).send('Internal Server Error');
                }

                if (user) {
                    // User exists, proceed with setting session variables
                    req.session.isAuthenticated = true;
                    req.session.username = user.username; // Or use the user's name from Google
                    res.redirect('/dashboard');
                } else {
                    // User does not exist, send an unauthorized error
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

// Dashboard Route
app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        // Fetch scans from the database
        const scans = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM scans', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Fetch dealer codes from the database
        const dealerCodes = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM dealer_codes', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Render the dashboard view and pass the data
        res.render('dashboard', { scans, username: req.session.username, dealerCodes });
    } catch (err) {
        console.error('Error fetching data from the database:', err.message);
        res.status(500).send('Error retrieving data from the database');
    }
});

// Add Dealer Code Route
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

// Delete Dealer Code Route
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

// Create HTTP server
app.listen(httpPort, () => {
    console.log(`HTTP server running at http://localhost:${httpPort}`);
});