#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

const tests = [
    'tests/btcrelay.test.ts',
    'tests/telebtc.test.ts', 
    'tests/transfer.test.ts',
    'tests/burn.test.ts',
    'tests/locker.test.ts'
];

console.log('Starting test suite execution...');
console.log('=================================');

let passed = 0;
let failed = 0;

for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    const testNumber = i + 1;
    const totalTests = tests.length;
    
    console.log('');
    console.log(`[${testNumber}/${totalTests}] Running: ${test}`);
    console.log('----------------------------------------');
    
    try {
        const command = `npm test -- --run ${test}`;
        execSync(command, { stdio: 'inherit' });
        console.log(`✅ ${test} - PASSED`);
        passed++;
    } catch (error) {
        console.log(`❌ ${test} - FAILED (Exit code: ${error.status})`);
        failed++;
    }
    
    if (i < tests.length - 1) {
        console.log('Waiting 2 seconds before next test...');
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

console.log('');
console.log('=================================');
console.log(`Test suite execution completed!`);
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`📊 Total: ${tests.length}`);

process.exit(failed > 0 ? 1 : 0);
