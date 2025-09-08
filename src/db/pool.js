import mysql from "mysql2/promise";
import "dotenv/config";

const pool = mysql.createPool({
  host:"localhost",
  port: "3306",
  user: "root",
  password:"7995",
  database: "latenigth",
  connectionLimit: 10,
  timezone: "Z" // Store/read as UTC
});

export default pool;
