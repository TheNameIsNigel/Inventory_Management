const express = require('express');
const db = require('./database');
const path = require('path');
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');
const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");
const app = express();

const httpPort = 3000;

// Load client secrets from a local file.
const credentials = require('./credentials.json'); // Downloaded from Google Cloud Console
const { client_secret, client_id, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

// Initialize Sentry
Sentry.init({
    dsn: "YOUR_SENTRY_DSN", // Replace with your Sentry DSN
    integrations: [
        nodeProfilingIntegration(),
        new Sentry.Integrations.Http({ tracing: true }),
        new Sentry.Integrations.Express({ app }),
        ...Sentry.autoDiscoverNodePerformanceMonitoringIntegrations(),
    ],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
    environment: process.env.NODE_ENV || "development", // Set environment
});

// Start profiling
Sentry.profiler.startProfiler();

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
    secret: 'your-secret-key', // Replace with a strong, random secret
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true when using HTTPS behind a reverse proxy
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// Add Sentry request handler as the first middleware
app.use(Sentry.Handlers.requestHandler());

// Add Sentry tracing handler
app.use(Sentry.Handlers.tracingHandler());

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Global error handler (should be after all routes)
app.use(function onError(err, req, res, next) {
    console.error(err.stack); // Log the error stack for debugging
    Sentry.captureException(err); // Send error to Sentry
    res.status(500).send('Something broke!');
});

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

            // Set the dealer code in the session
            req.session.dealerCodeAuthenticated = true;
            req.session.dealerCode = dealerCode;
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
    const dealerCode = req.session.dealerCode;

    // Fetch only the scans for the current session's dealer code
    db.all('SELECT * FROM scans WHERE dealer_code = ?', [dealerCode], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error retrieving scans from database');
        }
        res.render('index', { scans: rows, dealerCodeAuthenticated: true, dealerCode: dealerCode });
    });
});

// Scan Route (Logs out after each scan)
app.post('/scan', isValidDealerCode, (req, res) => {
    const { type, value } = req.body;
    const dealerCode = req.session.dealerCode;

    // Store the scan in the database with the associated dealer code
    db.run('INSERT INTO scans (type, value, dealer_code) VALUES (?, ?, ?)', [type, value, dealerCode], function (err) {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error saving scan to database.');
        }
        console.log(`A row has been inserted with rowid ${this.lastID}, associated with dealer code ${dealerCode}`);

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

// Add error handling middleware after all other routes
Sentry.setupExpressErrorHandler(app);

// Optional fallthrough error handler
app.use(function onError(err, req, res, next) {
    res.statusCode = 500;
    res.end("Response error: " + res.sentry + "\n");
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    Sentry.captureException(reason); // Send unhandled rejection to Sentry
});

// Create HTTP server
app.listen(httpPort, () => {
    console.log(`HTTP server running at http://localhost:${httpPort}`);
});