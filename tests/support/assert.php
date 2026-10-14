<?php
// Tiny dependency-free assertion helper used by the tests/*_test.php scripts.
// Each test file calls check()/checkEquals() and returns true/false from its
// run() function; tests/run.php aggregates the results and sets the exit code.

declare(strict_types=1);

final class TestFailure extends RuntimeException {}

function check(bool $condition, string $message): void {
    if (!$condition) {
        throw new TestFailure($message);
    }
}

function checkEquals(mixed $expected, mixed $actual, string $message): void {
    if ($expected !== $actual) {
        $expectedStr = json_encode($expected, JSON_UNESCAPED_UNICODE);
        $actualStr = json_encode($actual, JSON_UNESCAPED_UNICODE);
        throw new TestFailure("$message\n  expected: $expectedStr\n  actual:   $actualStr");
    }
}
