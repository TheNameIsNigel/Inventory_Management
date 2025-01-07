const sqlite3 = require('sqlite3').verbose();

let db = new sqlite3.Database('./scans.db', (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to the scans.db database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT,
        imei TEXT,
        dealer_code_id INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(dealer_code_id) REFERENCES dealer_codes(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        isAdmin BOOLEAN DEFAULT FALSE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS dealer_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT
    )`);

    const adminUsername = 'rnigeluno';
    const adminEmail = 'rnigeluno@gmail.com';

    db.get('SELECT id FROM users WHERE username = ?', [adminUsername], (err, row) => {
        if (err) {
            console.error(err.message);
            return;
        }

        if (!row) {
            db.run('INSERT INTO users (username, email, isAdmin) VALUES (?, ?, ?)', [adminUsername, adminEmail, true], function(err) {
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