-- =============================================
--  MySQL Setup Script
--  Run this in phpMyAdmin (XAMPP)
-- =============================================

-- 1. Create the database
CREATE DATABASE IF NOT EXISTS attendance_db;
USE attendance_db;

-- 2. Table: Terminals / Devices
--    One row per Hikvision device
CREATE TABLE IF NOT EXISTS xx_att_api (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  ip_address    VARCHAR(50)   NOT NULL,
  in_out        TINYINT       NOT NULL COMMENT '1=IN, 2=OUT, 3=AUTO by time',
  api_string    VARCHAR(255)  NOT NULL COMMENT 'Full API URL of the device',
  location      VARCHAR(100),
  status        TINYINT       DEFAULT 1 COMMENT '1=Active, 0=Inactive'
);

-- 3. Table: Attendance Logs
--    One row per punch (face recognition event)
CREATE TABLE IF NOT EXISTS xx_attlog_hik (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  am_empno                VARCHAR(50)   NOT NULL COMMENT 'Employee number from device',
  am_time_in_out          VARCHAR(50)   NOT NULL COMMENT 'Original ISO time from device',
  am_type_in_out          TINYINT       NOT NULL COMMENT '1=IN, 2=OUT',
  am_mac_id               VARCHAR(50)   NOT NULL COMMENT 'Device IP address',
  am_time_in_out_simple   DATETIME      NOT NULL COMMENT 'Clean datetime for queries',
  created_at              TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,

  -- Prevent duplicate punches from same employee at same time on same device
  UNIQUE KEY unique_punch (am_empno, am_time_in_out, am_mac_id)
);

-- =============================================
--  4. Insert your Hikvision device
--     CHANGE the IP to your actual device IP!
-- =============================================
INSERT INTO xx_att_api (ip_address, in_out, api_string, location, status)
VALUES (
  '192.168.0.107',   -- << CHANGE THIS to your device IP (from SADP Tool)
  3,                -- 3 = Auto (before 11am = IN, after = OUT)
  'http://192.168.0.107/ISAPI/AccessControl/AcsEvent?format=json',  -- << CHANGE IP here too
  'Main Entrance',
  1
);

-- If you have more devices, add more rows:
-- INSERT INTO xx_att_api (ip_address, in_out, api_string, location, status)
-- VALUES ('192.168.1.65', 1, 'http://192.168.1.65/ISAPI/AccessControl/AcsEvent?format=json', 'Exit Gate', 1);