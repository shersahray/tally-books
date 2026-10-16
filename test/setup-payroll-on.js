// The tests cover payroll's code too, so they run with payroll switched on, as it will be once it launches.
// test/payroll-coming-soon.test.js checks the switched-off version people get today (plans.js COMING_SOON).
process.env.SUMLORA_PAYROLL = 'on';
// Year-end files are coming soon too; the tests cover them switched on (test/yearend-files.test.js checks the switched-off version).
process.env.SUMLORA_YEAREND = 'on';
