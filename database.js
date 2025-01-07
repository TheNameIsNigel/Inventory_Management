const sqlite3 = require('sqlite3').verbose();

let db = new sqlite3.Database('./scans.db', (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to the scans.db database.');
});

db.serialize(() => {
    // Create the 'stores' table
    db.run(`CREATE TABLE IF NOT EXISTS stores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        address TEXT
    )`);

    // Create the 'scans' table
    db.run(`CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT,
        imei TEXT,
        dealer_code_id INTEGER,
        store_id INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(dealer_code_id) REFERENCES dealer_codes(id),
        FOREIGN KEY(store_id) REFERENCES stores(id)
    )`);

    // Create the 'users' table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        isAdmin BOOLEAN DEFAULT FALSE,
        primary_admin BOOLEAN DEFAULT FALSE,
        store_id INTEGER,
        FOREIGN KEY(store_id) REFERENCES stores(id)
    )`);

    // Create the 'dealer_codes' table
    db.run(`CREATE TABLE IF NOT EXISTS dealer_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT,
        store_id INTEGER,
        FOREIGN KEY(store_id) REFERENCES stores(id)
    )`);

    // Example to check for the first user and make them primary admin
    const adminUsername = 'rnigeluno'; // This is just a placeholder, as the first user to register will become the primary admin
    const adminEmail = 'rnigeluno@gmail.com'; // This is just a placeholder, as the first user to register will become the primary admin

    db.get('SELECT id FROM users WHERE username = ?', [adminUsername], (err, row) => {
        if (err) {
            console.error(err.message);
            return;
        }

        if (!row) {
            db.run('INSERT INTO users (username, email, isAdmin, primary_admin) VALUES (?, ?, ?, ?)', [adminUsername, adminEmail, true, true], function(err) {
                if (err) {
                    console.error(err.message);
                    return;
                }
                console.log(`Admin user created with ID ${this.lastID}`);
            });
        }
    });
});

module.exports = db;