<?php
// Database credentials.
// On the server: create db.config.php next to this file with:
//   <?php $db_pass = 'your_actual_password';
// That file is never committed to git.
$host = 'localhost';
$db   = getenv('DB_NAME') ?: 'u566589045_radioller';
$user = getenv('DB_USER') ?: 'u566589045_radiolleruser';
$db_pass = '';
@include __DIR__ . '/db.config.php';   // sets $db_pass — server-only, gitignored
$pass = getenv('DB_PASS') ?: $db_pass;

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8mb4", $user, $pass, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
} catch (PDOException $e) {
    http_response_code(503);
    die(json_encode(['error' => 'Database unavailable']));
}
