const express = require('express');
const db = require('./database');
const path = require('path');
const session = require('express-session');
const { google, outlook, microsoft } = require('googleapis');
const fs = require('fs');
const app = express();
const multer = require('multer');
const upload = multer();
const moment = require('moment-timezone');

const httpPort = 3000;
const credentials = require('./credentials.json');
const { client_secret, client_id, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const microsoftClientId = credentials.microsoft.client_id;
const microsoftClientSecret = credentials.microsoft.client_secret;
const microsoftRedirectUri = credentials.microsoft.redirect_uris[0];

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

function isAdmin(req, res, next) {
    if (req.session.isAdmin) {
        return next();
    }
    res.status(403).send('Access Denied');
}

// Function to get the greeting based on time of day
function getGreeting(dealerName) {
    const hour = new Date().getHours();
    let greeting = 'Good ';

    if (hour >= 5 && hour < 12) {
        greeting += 'Morning';
    } else if (hour >= 12 && hour < 18) {
        greeting += 'Afternoon';
    } else {
        greeting += 'Evening';
    }

    return `${greeting}, ${dealerName}!`;
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
            req.session.dealerName = dealerCodeRecord.name; // Store dealer name in session
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

// Protected route for the scanning page
app.get('/', isValidDealerCode, (req, res) => {
    const dealerName = req.session.dealerName || 'Dealer';
    const greeting = getGreeting(dealerName);

    // Fetch only the scans for the logged-in dealer for the current day, in EST
    const todayEST = moment.tz('America/New_York').format('YYYY-MM-DD');
    db.all(`SELECT *, datetime(timestamp, 'localtime') as timestamp FROM scans WHERE dealer_code_id = ? AND DATE(timestamp, 'localtime') = ?`, [req.session.dealerCodeId, todayEST], (err, rows) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error fetching scans from database.');
        }
        res.render('index', { scans: rows, dealerCodeAuthenticated: req.session.dealerCodeAuthenticated, greeting: greeting });
    });
});


// Use multer middleware for /scan route
app.post('/scan', upload.none(), (req, res) => { // Use upload.none() since you're not handling files
    console.log("Request Body (Raw):", req.body); // Log the raw request body

    const { sku, imei } = req.body; // Destructure sku and imei

    // Log the extracted values
    console.log("Extracted SKU:", sku);
    console.log("Extracted IMEI:", imei);

    const dealerCodeId = req.session.dealerCodeId;
    console.log("Dealer Code ID:", dealerCodeId);

    // Validate data (check if sku and imei are not empty)
    if (!sku || !imei) {
        console.error("Error: SKU or IMEI is missing.");
        return res.status(400).json({ error: 'SKU or IMEI is missing' }); // Send JSON error
    }

    // Get the current time in EST
    const currentTimeEST = moment.tz('America/New_York').format('YYYY-MM-DD HH:mm:ss');

    // Use parameterized query to prevent SQL injection
    const sql = 'INSERT INTO scans (sku, imei, dealer_code_id, timestamp) VALUES (?, ?, ?, ?)';
    db.run(sql, [sku, imei, dealerCodeId, currentTimeEST], function (err) {
        if (err) {
            console.error("Database Error:", err.message);
            return res.status(500).json({ error: 'Error saving scan to database' }); // Send JSON error
        }

        // Log the successful insertion
        console.log(`A row has been inserted with rowid ${this.lastID}`);

        // Reset dealer code authentication
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
    res.render('login', { authUrl });
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
            db.get('SELECT * FROM users WHERE email = ?', [userEmail], async (err, user) => {
                if (err) {
                    console.error(err.message);
                    return res.status(500).send('Internal Server Error');
                }

                let isAdmin = false;
                let isPrimaryAdmin = false;

                // Check if user exists
                if (!user) {
                    // Check if it's the first user (primary admin)
                    const firstUser = await new Promise((resolve, reject) => {
                        db.get('SELECT * FROM users', [], (err, row) => {
                            if (err) reject(err);
                            resolve(row);
                        });
                    });

                    if (!firstUser) {
                        isPrimaryAdmin = true;
                        isAdmin = true;
                    }
                    if (userEmail.endsWith('@t-mobile.com')) {
                        isAdmin = true;
                    }

                    // Insert new user
                    db.run('INSERT INTO users (username, email, isAdmin, primary_admin) VALUES (?, ?, ?, ?)', [userEmail, userEmail, isAdmin, isPrimaryAdmin], function(err) {
                        if (err) {
                            console.error(err.message);
                            return res.status(500).send('Error creating user');
                        }
                        console.log(`New user created with ID ${this.lastID}`);
                        req.session.isAuthenticated = true;
                        req.session.username = userEmail; // Default username to email
                        req.session.isAdmin = isAdmin;
                        res.redirect('/dashboard');
                    });
                } else {
                    // Existing user
                    req.session.isAuthenticated = true;
                    req.session.username = user.username;
                    req.session.isAdmin = user.isAdmin;
                    res.redirect('/dashboard');
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

// Microsoft Login
app.get('/auth/microsoft', (req, res) => {
    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=<span class="math-inline">\{microsoftClientId\}&response\_type\=code&redirect\_uri\=</span>{microsoftRedirectUri}&response_mode=query&scope=openid%20profile%20email&state=12345`;
    res.redirect(authUrl);
});

app.get('/auth/microsoft/callback', async (req, res) => {
    const { code } = req.query;

    try {
        const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: microsoftClientId,
                scope: 'openid profile email',
                code: code,
                redirect_uri: microsoftRedirectUri,
                grant_type: 'authorization_code',
                client_secret: microsoftClientSecret
            })
        });

        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;

        // Fetch user information using the access token
        const userResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        const userData = await userResponse.json();
        const userEmail = userData.mail || userData.userPrincipalName;

        // Check if user exists in the database
        db.get('SELECT * FROM users WHERE email = ?', [userEmail], async (err, user) => {
            if (err) {
                console.error(err.message);
                return res.status(500).send('Internal Server Error');
            }

            let isAdmin = false;
            let isPrimaryAdmin = false;

            if (!user) {
                // Check if it's the first user (primary admin)
                const firstUser = await new Promise((resolve, reject) => {
                    db.get('SELECT * FROM users', [], (err, row) => {
                        if (err) reject(err);
                        resolve(row);
                    });
                });

                if (!firstUser) {
                    isPrimaryAdmin = true;
                    isAdmin = true;
                }

                if (userEmail.endsWith('@t-mobile.com')) {
                    isAdmin = true;
                }

                // Insert new user
                db.run('INSERT INTO users (username, email, isAdmin, primary_admin) VALUES (?, ?, ?, ?)', [userEmail, userEmail, isAdmin, isPrimaryAdmin], function(err) {
                    if (err) {
                        console.error(err.message);
                        return res.status(500).send('Error creating user');
                    }
                    console.log(`New user created with ID ${this.lastID}`);
                    req.session.isAuthenticated = true;
                    req.session.username = userEmail; // Default username to email
                    req.session.isAdmin = isAdmin;
                    res.redirect('/dashboard');
                });
            } else {
                // Existing user
                req.session.isAuthenticated = true;
                req.session.username = user.username;
                req.session.isAdmin = user.isAdmin;
                res.redirect('/dashboard');
            }
        });
    } catch (error) {
        console.error('Error during Microsoft authentication:', error);
        res.status(500).send('Authentication error');
    }
});

app.get('/dashboard', isAuthenticated, isAdmin, async (req, res) => {
    // Get filter parameters from query string
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const dealerCodeId = req.query.dealerCode;

    // Construct the base SQL query
    let sql = `
        SELECT scans.*, dealer_codes.code AS dealerCode, dealer_codes.name AS dealerName 
        FROM scans 
        LEFT JOIN dealer_codes ON scans.dealer_code_id = dealer_codes.id
    `;
    const queryParams = [];

    // Add WHERE clauses based on filters
    if (startDate || endDate || dealerCodeId) {
        sql += ' WHERE ';
        const conditions = [];

        if (startDate) {
            conditions.push('DATE(scans.timestamp) >= ?');
            queryParams.push(startDate);
        }

        if (endDate) {
            conditions.push('DATE(scans.timestamp) <= ?');
            queryParams.push(endDate);
        }

        if (dealerCodeId) {
            conditions.push('scans.dealer_code_id = ?');
            queryParams.push(dealerCodeId);
        }

        sql += conditions.join(' AND ');
    }

    // Order the results
    sql += ' ORDER BY scans.timestamp DESC';

    try {
        const scans = await new Promise((resolve, reject) => {
            db.all(sql, queryParams, (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        const dealerCodes = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM dealer_codes', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        const users = await new Promise((resolve, reject) => {
            db.all('SELECT id, username, email FROM users', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        res.render('dashboard', { scans, username: req.session.username, dealerCodes, startDate, endDate, dealerCodeId, users });
    } catch (err) {
        console.error('Error fetching data from the database:', err.message);
        res.status(500).send('Error retrieving data from the database');
    }
});

app.post('/add-dealer-code', isAuthenticated, isAdmin, (req, res) => {
    const { dealerCode, dealerName } = req.body;

    db.run('INSERT INTO dealer_codes (code, name) VALUES (?, ?)', [dealerCode, dealerName], function(err) {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error adding dealer code.');
        }
        console.log(`Dealer code added with ID ${this.lastID}`);
        res.redirect('/dashboard');
    });
});

app.post('/delete-dealer-code/:id', isAuthenticated, isAdmin, (req, res) => {
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
        res.redirect('/dealer-login');
    });
});

app.listen(httpPort, () => {
    console.log(`HTTP server running at http://localhost:${httpPort}`);
});