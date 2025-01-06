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
        type TEXT,
        value TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        dealer_code TEXT,
        FOREIGN KEY (dealer_code) REFERENCES dealer_codes(code)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE
    )`);

    // Create the dealer_codes table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS dealer_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL
    )`);

    // Add the email column to the users table if it doesn't exist
    db.run('ALTER TABLE users ADD COLUMN email TEXT UNIQUE', [], function(err) {
        if (err) {
            // Handle error (e.g., column might already exist)
            console.error("Error altering table:", err.message);
        } else {
            console.log("Column 'email' added to users table.");
        }
    });

    // Insert an initial admin user if it doesn't exist
    const adminUsername = 'rnigeluno';
    const adminEmail = 'rnigeluno@gmail.com'; // Replace with the actual admin email

    db.get('SELECT id FROM users WHERE username = ?', [adminUsername], (err, row) => {
        if (err) {
            console.error(err.message);
            return;
        }

        if (!row) {
            db.run('INSERT INTO users (username, email) VALUES (?, ?)', [adminUsername, adminEmail], function(err) {
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