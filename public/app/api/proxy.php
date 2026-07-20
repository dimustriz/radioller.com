<?php
/**
 * proxy.php — CORS-aware audio stream proxy.
 *
 * Fetches a radio stream URL server-side and forwards the bytes to the browser
 * with Access-Control-Allow-Origin: * headers, enabling Web Audio API recording
 * in Safari and all other browsers without cross-origin restrictions.
 *
 * GET /api/proxy.php?url=<encoded-stream-url>
 *
 * Security: SSRF-safe (blocks private/loopback/reserved IP ranges).
 */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Range');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$url = isset($_GET['url']) ? trim($_GET['url']) : '';

if ($url === '') {
    http_response_code(400);
    exit('Missing url parameter');
}

// Only allow HTTP/HTTPS
if (!preg_match('/^https?:\/\//i', $url)) {
    http_response_code(400);
    exit('Only http/https URLs are allowed');
}

// SSRF prevention: resolve host and block private/reserved ranges
$host = parse_url($url, PHP_URL_HOST);
if (empty($host)) {
    http_response_code(400);
    exit('Invalid URL');
}

$ip = @gethostbyname($host);
if (
    $ip === $host || // DNS resolution failed (returned input unchanged)
    !isPublicIp($ip)
) {
    http_response_code(403);
    exit('Address not allowed');
}

// Disable PHP execution timeout and output buffering for streaming
@set_time_limit(0);
@ini_set('output_buffering', 'off');
@ini_set('zlib.output_compression', '0');
if (function_exists('apache_setenv')) {
    @apache_setenv('no-gzip', '1');
}

// Tell LiteSpeed / Nginx not to buffer this response
header('X-Accel-Buffering: no');
header('Cache-Control: no-cache, no-store');
// Default content-type; overridden below if upstream sends one
header('Content-Type: application/octet-stream');

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS       => 3,
    CURLOPT_CONNECTTIMEOUT  => 10,
    CURLOPT_TIMEOUT         => 0,          // no timeout — stream runs until client disconnects
    CURLOPT_USERAGENT       => 'Mozilla/5.0 (compatible; Radioller/1.0)',
    CURLOPT_SSL_VERIFYPEER  => false,      // radio stations often have self-signed / expired certs
    CURLOPT_SSL_VERIFYHOST  => 0,
    CURLOPT_HEADERFUNCTION  => function ($ch, $header) {
        $name = strtolower(strtok($header, ':'));
        // Forward audio content-type and ICY metadata headers
        if (in_array($name, ['content-type', 'icy-name', 'icy-br', 'icy-metaint', 'icy-genre'], true)) {
            header(rtrim($header), false);
        }
        return strlen($header);
    },
    CURLOPT_WRITEFUNCTION   => function ($ch, $data) {
        echo $data;
        if (ob_get_level() > 0) {
            ob_flush();
        }
        flush();
        return strlen($data);
    },
]);

$ok = curl_exec($ch);
if (!$ok) {
    $err = curl_error($ch);
    http_response_code(502);
    echo 'Upstream error: ' . htmlspecialchars($err, ENT_QUOTES, 'UTF-8');
}
curl_close($ch);

// ?? helpers ??????????????????????????????????????????????????????????????????

function isPublicIp(string $ip): bool
{
    // Returns true only for routable public addresses
    return filter_var(
        $ip,
        FILTER_VALIDATE_IP,
        FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
    ) !== false;
}
