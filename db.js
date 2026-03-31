// =============================================
//  db.js — MySQL connection (XAMPP)
// =============================================
require("dotenv").config();
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "attendance_db",
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;