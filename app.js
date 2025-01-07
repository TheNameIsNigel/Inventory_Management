const express = require('express');
const db = require('./database');
const path = require('path');
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');
const app = express();
const multer = require('multer');
const upload = multer();
const moment = require('moment-timezone');

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

function isAdmin(req, res, next) {
    // Check if the user is an admin and not a primary admin
    if (req.session.isAdmin || req.session.isPrimaryAdmin) {
        return next();
    }
    res.status(403).send('Access Denied');
}

function isPrimaryAdmin(req, res, next) {
    if (req.session.isPrimaryAdmin) {
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

            // Check if the user's session indicates they are logged in and isAdmin
            if (req.session.isAuthenticated && req.session.isAdmin) {
                req.session.dealerCodeAuthenticated = true;
                req.session.dealerCodeId = dealerCodeRecord.id;
                req.session.dealerName = dealerCodeRecord.name;
                req.session.storeId = dealerCodeRecord.store_id;
                res.redirect('/');
            } else {
                // If user is not an admin, check if the dealer code belongs to a specific store
                if (dealerCodeRecord.store_id) {
                    req.session.dealerCodeAuthenticated = true;
                    req.session.dealerCodeId = dealerCodeRecord.id;
                    req.session.dealerName = dealerCodeRecord.name;
                    req.session.storeId = dealerCodeRecord.store_id;
                    res.redirect('/');
                } else {
                    // If the dealer code does not belong to a store, deny access
                    res.status(403).send('Access Denied: Dealer code is not associated with a store.');
                }
            }
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

    const storeId = req.session.storeId;
    console.log("Store ID:", storeId);

    // Validate data (check if sku and imei are not empty)
    if (!sku || !imei) {
        console.error("Error: SKU or IMEI is missing.");
        return res.status(400).json({ error: 'SKU or IMEI is missing' }); // Send JSON error
    }

    // Get the current time in EST
    const currentTimeEST = moment.tz('America/New_York').format('YYYY-MM-DD HH:mm:ss');

    // Use parameterized query to prevent SQL injection
    const sql = 'INSERT INTO scans (sku, imei, dealer_code_id, store_id, timestamp) VALUES (?, ?, ?, ?, ?)';
    db.run(sql, [sku, imei, dealerCodeId, storeId, currentTimeEST], function (err) {
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
    res.render('login', { authUrl }); // Assuming you have a login.ejs file
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

                // Check if it's the first user (primary admin) or the specific rnigeluno@gmail.com
                const firstUser = await new Promise((resolve, reject) => {
                    db.get('SELECT * FROM users', [], (err, row) => {
                        if (err) reject(err);
                        resolve(row);
                    });
                });

                if (!firstUser || userEmail === 'rnigeluno@gmail.com') {
                    isPrimaryAdmin = true;
                    isAdmin = true;
                } else if (userEmail.endsWith('@t-mobile.com')) {
                    isAdmin = true;
                }

                if (!user) {
                    // Insert new user
                    db.run('INSERT INTO users (username, email, isAdmin, primary_admin) VALUES (?, ?, ?, ?)', [userEmail, userEmail, isAdmin, isPrimaryAdmin], function(err) {
                        if (err) {
                            console.error(err.message);
                            return res.status(500).send('Error creating user');
                        }
                        console.log(`New user created with ID ${this.lastID}`);

                        // Set the session variables after successful user creation
                        req.session.isAuthenticated = true;
                        req.session.username = userEmail; // Default username to email
                        req.session.isAdmin = isAdmin;
                        req.session.isPrimaryAdmin = isPrimaryAdmin;
                        req.session.userId = this.lastID;
                        req.session.storeId = null; // Set storeId to null for new users
                        if (isPrimaryAdmin) {
                            res.redirect('/dashboard');
                        } else if (isAdmin) {
                            res.redirect(`/store/undefined`); // Redirect to their store's page
                        } else {
                            res.redirect('/');
                        }
                    });
                } else {
                    // Existing user
                    // Update user's admin status
                    db.run('UPDATE users SET isAdmin = ?, primary_admin = ? WHERE id = ?', [isAdmin, isPrimaryAdmin, user.id], function(err) {
                        if (err) {
                            console.error(err.message);
                            return res.status(500).send('Error updating user');
                        }
                        console.log(`User ${user.id} updated successfully`);

                        req.session.isAuthenticated = true;
                        req.session.username = user.username;
                        req.session.isAdmin = isAdmin;
                        req.session.isPrimaryAdmin = isPrimaryAdmin;
                        req.session.userId = user.id;
                        req.session.storeId = user.store_id;
                        if (isPrimaryAdmin) {
                            res.redirect('/dashboard');
                        } else if (isAdmin) {
                            res.redirect(`/store/${user.store_id}`);
                        } else {
                            res.redirect('/');
                        }
                    });
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
    if (req.session.isAdmin && !req.session.isPrimaryAdmin) {
        return res.redirect(`/store/${req.session.storeId}`);
    }

    // Get filter parameters from query string
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const dealerCodeId = req.query.dealerCode;
    const storeId = req.query.store;

    // Construct the base SQL query
    let sql = `
        SELECT scans.*, 
               dealer_codes.code AS dealerCode, 
               dealer_codes.name AS dealerName,
               stores.name AS storeName
        FROM scans 
        LEFT JOIN dealer_codes ON scans.dealer_code_id = dealer_codes.id
        LEFT JOIN stores ON scans.store_id = stores.id
    `;
    const queryParams = [];

    // Add WHERE clauses based on filters
    if (startDate || endDate || dealerCodeId || storeId) {
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

        if (storeId) {
            conditions.push('scans.store_id = ?');
            queryParams.push(storeId);
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

        const stores = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM stores', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        const users = await new Promise((resolve, reject) => {
            db.all('SELECT id, username, email, store_id FROM users', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        res.render('dashboard', {
            scans,
            username: req.session.username,
            dealerCodes,
            startDate,
            endDate,
            dealerCodeId,
            stores,
            storeId,
            users
        });
    } catch (err) {
        console.error('Error fetching data from the database:', err.message);
        res.status(500).send('Error retrieving data from the database');
    }
});

app.post('/add-dealer-code', isAuthenticated, isAdmin, (req, res) => {
    const { dealerCode, dealerName, storeId } = req.body;

    if (req.session.isPrimaryAdmin) {
        // Primary admin can add dealer codes to any store
        db.run('INSERT INTO dealer_codes (code, name, store_id) VALUES (?, ?, ?)', [dealerCode, dealerName, storeId], function(err) {
            if (err) {
                console.error(err.message);
                return res.status(500).send('Error adding dealer code.');
            }
            console.log(`Dealer code added with ID ${this.lastID}`);
            res.redirect('/dashboard');
        });
    } else if (req.session.storeId) {
        // Check if the logged-in user is an admin for the store
        db.get('SELECT id FROM users WHERE id = ? AND store_id = ? AND isAdmin = 1', [req.session.userId, req.session.storeId], (err, user) => {
            if (err) {
                console.error(err.message);
                return res.status(500).send('Error verifying admin status.');
            }
            if (user) {
                // Store admin can only add dealer codes to their own store
                db.run('INSERT INTO dealer_codes (code, name, store_id) VALUES (?, ?, ?)', [dealerCode, dealerName, req.session.storeId], function(err) {
                    if (err) {
                        console.error(err.message);
                        return res.status(500).send('Error adding dealer code.');
                    }
                    console.log(`Dealer code added with ID ${this.lastID} for store ${req.session.storeId}`);
                    res.redirect(`/store/${req.session.storeId}`);
                });
            } else {
                res.status(403).send('Access Denied: Not authorized to add dealer codes for this store.');
            }
        });
    } else {
        res.status(403).send('Access Denied: Store ID not set.');
    }
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

// Add a new route to handle store creation
app.post('/create-store', isAuthenticated, isPrimaryAdmin, (req, res) => {
    const { storeName, storeAddress } = req.body;

    // Prevent stores with the same name from being created
    db.get('SELECT id FROM stores WHERE name = ?', [storeName], function(err, existingStore) {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error checking for existing store.');
        }

        if (existingStore) {
            // Store with the same name already exists
            console.error(`Store with name ${storeName} already exists.`);
            return res.status(409).send('A store with this name already exists.');
        }

        // No store with the same name exists, proceed with creation
        db.run('INSERT INTO stores (name, address) VALUES (?, ?)', [storeName, storeAddress], function(err) {
            if (err) {
                console.error(err.message);
                return res.status(500).send('Error creating store.');
            }
            console.log(`Store created with ID ${this.lastID}`);
            res.redirect('/dashboard');
        });
    });
});

// Add a new route to handle assigning admins to stores
app.post('/assign-admin', isAuthenticated, isPrimaryAdmin, (req, res) => {
    const { userId, storeId } = req.body;

    // Check if the selected user is the primary admin
    db.get('SELECT primary_admin FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error checking user admin status.');
        }

        if (user && user.primary_admin) {
            console.error('Cannot assign a store to the primary admin.');
            return res.status(400).send('Cannot assign a store to the primary admin.');
        }

        // Proceed with updating the user's store assignment
        db.run('UPDATE users SET store_id = ? WHERE id = ?', [storeId, userId], function(err) {
            if (err) {
                console.error(err.message);
                return res.status(500).send('Error assigning admin to store.');
            }
            console.log(`Admin ${userId} assigned to store ${storeId}`);
            res.redirect('/dashboard');
        });
    });
});

// Add a new route to handle assigning dealers to stores
app.post('/assign-dealer', isAuthenticated, isAdmin, (req, res) => {
    const { dealerId, storeId } = req.body;

    db.run('UPDATE dealer_codes SET store_id = ? WHERE id = ?', [storeId, dealerId], function(err) {
        if (err) {
            console.error(err.message);
            return res.status(500).send('Error assigning dealer to store.');
        }
        console.log(`Dealer ${dealerId} assigned to store ${storeId}`);
        res.redirect('/dashboard');
    });
});

app.get('/store/:storeId', isAuthenticated, async (req, res) => {
    const { storeId } = req.params;

    // Check if the user is an admin
    if (!req.session.isAdmin) {
        return res.status(403).send('Access Denied');
    }

    // Only allow access if user is primary admin or store admin for the specific store
    if (!req.session.isPrimaryAdmin && req.session.storeId.toString() !== storeId) {
        return res.status(403).send('Access Denied');
    }

    // Get filter parameters from query string
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const dealerCodeId = req.query.dealerCode;

    // Construct the base SQL query
    let sql = `
        SELECT scans.*, dealer_codes.code AS dealerCode, dealer_codes.name AS dealerName
        FROM scans
        LEFT JOIN dealer_codes ON scans.dealer_code_id = dealer_codes.id
        WHERE scans.store_id = ?
    `;
    const queryParams = [storeId];

    // Add WHERE clauses based on filters
    const conditions = [];
    if (startDate) {
        conditions.push('DATE(scans.timestamp, \'localtime\') >= ?');
        queryParams.push(startDate);
    }
    if (endDate) {
        conditions.push('DATE(scans.timestamp, \'localtime\') <= ?');
        queryParams.push(endDate);
    }
    if (dealerCodeId) {
        conditions.push('scans.dealer_code_id = ?');
        queryParams.push(dealerCodeId);
    }

    if (conditions.length > 0) {
        sql += ' AND ' + conditions.join(' AND ');
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
            db.all('SELECT * FROM dealer_codes WHERE store_id = ?', [storeId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Fetch the store name using the storeId from the URL
        const store = await new Promise((resolve, reject) => {
            db.get('SELECT name FROM stores WHERE id = ?', [storeId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        res.render('store', {
            scans,
            username: req.session.username,
            dealerCodes,
            startDate,
            endDate,
            dealerCodeId,
            storeName: store ? store.name : null, // Pass the store name to the template
            storeId
        });
    } catch (err) {
        console.error('Error fetching data from the database:', err.message);
        res.status(500).send('Error retrieving data from the database');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).send('Logout failed');
        }
        res.redirect('/dealer-login'); // Redirect to dealer-login after logout
    });
});

app.listen(httpPort, () => {
    console.log(`HTTP server running at http://localhost:${httpPort}`);
});