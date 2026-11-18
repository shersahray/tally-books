'use strict';

const { ValidationError } = require('./validate');

function reportPeriod(query, today) {
  const from = query.get('from') ?? today.slice(0, 7) + '-01';
  const to = query.get('to') ?? today;
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(value + 'T00:00:00Z').toJSON()?.slice(0, 10) === value;
  if (!valid(from) || !valid(to) || from > to) throw new ValidationError('Choose a valid reporting period.');
  return { from, to };
}

// The accrual P&L groups the same posted journal lines into Income, Cost of Goods Sold and Expense.
function locationProfitAndLoss(store, from, to, includeAccounts) {
  const balances = new Map(store.periodBalances(from, to).map(({ id, cents }) => [id, cents]));
  const p = { revenue: 0, costOfSales: 0, operatingExpenses: 0 };
  const breakdown = [];
  for (const account of store.list('accounts')) {
    const cents = balances.get(account.id) || 0;
    if (!cents) continue;
    let amount = cents;
    switch (account.type) {
      case 'Income': amount = -cents; p.revenue += amount; break;
      case 'Cost of Goods Sold': p.costOfSales += amount; break;
      case 'Expense': p.operatingExpenses += amount; break;
      default: continue;
    }
    if (includeAccounts) breakdown.push({ code: account.code, name: account.name, type: account.type, amount });
  }
  const expenses = p.costOfSales + p.operatingExpenses;
  return {
    ...p, expenses, netIncome: p.revenue - expenses,
    closed: (store.getSetting('closing')?.date || '') >= to,
    ...(includeAccounts ? { breakdown } : {}),
  };
}

module.exports = { reportPeriod, locationProfitAndLoss };
