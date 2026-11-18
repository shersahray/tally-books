'use strict';

let restaurantGroupAvailable = false;
let restaurantGroup = null;
let restaurantRefreshTimer;

function showRestaurantGroup() {
  restaurantGroup = { from: today().slice(0, 7) + '-01', to: today(), location: '' };
  S.view = 'restaurantGroup';
  renderMain();
  return loadRestaurantGroup();
}

async function loadRestaurantGroup() {
  const state = restaurantGroup;
  if (!state || S.view !== 'restaurantGroup') return;
  const request = state.request = (state.request || 0) + 1;
  const current = () => state === restaurantGroup && request === state.request && S.view === 'restaurantGroup';
  const query = new URLSearchParams({ from: state.from, to: state.to, location: state.location });
  try {
    const data = await api('GET', '/api/restaurant-group?' + query);
    if (!current()) return;
    state.data = data;
    state.error = '';
  } catch (error) {
    if (!current()) return;
    state.data = null;
    state.error = error.message;
    if (error.status === 404 && state.location) {
      state.location = '';
      return loadRestaurantGroup();
    }
  }
  renderMain();
}

function refreshRestaurantGroup(event) {
  if (S.view !== 'restaurantGroup' || (!event.companies && !restaurantGroup?.data?.rows.some(row => row.id === event.company))) return;
  clearTimeout(restaurantRefreshTimer);
  restaurantRefreshTimer = setTimeout(loadRestaurantGroup, 650);
}

function vRestaurantGroup() {
  const state = restaurantGroup;
  const data = state.data;
  const dollars = new Intl.NumberFormat(LOC(), { style: 'currency', currency: 'CAD' });
  const percent = new Intl.NumberFormat(LOC(), { style: 'percent', maximumFractionDigits: 1 });
  const amount = cents => `<span class="${cents < 0 ? 'neg' : ''}">${esc(dollars.format(cents / 100))}</span>`;
  const margin = (net, revenue) => revenue ? esc(percent.format(net / revenue)) : '—';
  const report = head('Restaurant Group Dashboard', 'Accrual P&amp;L from posted Sumlora transactions.',
    '<button class="btn" data-rg-back>Companies</button>');
  const period = `<form class="panel toolbar" id="restaurantPeriod">
    <label>From <input type="date" name="from" required value="${esc(state.draftFrom ?? state.from)}"></label>
    <label>To <input type="date" name="to" required value="${esc(state.draftTo ?? state.to)}"></label>
    <button class="btn primary" type="submit">Update</button></form>`;
  if (!data) return report + period + (state.error ? `<div class="banner err">${esc(state.error)}</div>` : '<div class="panel"><div class="empty">Loading reports…</div></div>');

  const visible = data.rows.filter(row => !row.locked && !row.billingRequired);
  const totals = visible.reduce((total, row) => ({
    revenue: total.revenue + row.revenue,
    expenses: total.expenses + row.expenses,
    netIncome: total.netIncome + row.netIncome,
  }), { revenue: 0, expenses: 0, netIncome: 0 });
  const rows = data.rows.map(row => {
    const name = esc(row.name);
    if (row.locked) return `<tr><th scope="row">${name}</th><td colspan="5"><button type="button" class="btn sm" data-rg-unlock="${esc(row.id)}">Enter company code</button></td></tr>`;
    if (row.billingRequired) return `<tr><th scope="row">${name}</th><td colspan="5">Subscription required</td></tr>`;
    return `<tr><th scope="row"><button type="button" class="link" data-rg-location="${esc(row.id)}">${name}</button></th>
      <td class="n">${amount(row.revenue)}</td><td class="n">${amount(row.expenses)}</td>
      <td class="n">${amount(row.netIncome)}</td><td class="n">${margin(row.netIncome, row.revenue)}</td>
      <td>${row.closed ? 'Closed' : 'Preliminary'}</td></tr>`;
  }).join('');
  const total = visible.length ? `<tfoot><tr><th scope="row">${visible.length < data.rows.length ? 'Total for available locations' : 'Group total'}</th>
    <td class="n">${amount(totals.revenue)}</td><td class="n">${amount(totals.expenses)}</td>
    <td class="n">${amount(totals.netIncome)}</td><td class="n">${margin(totals.netIncome, totals.revenue)}</td><td></td></tr></tfoot>` : '';
  const selected = visible.find(row => row.id === state.location && row.breakdown);
  const detail = selected ? `<div class="panel"><h3>${esc(selected.name)} · Profit and loss</h3><div class="tbl-wrap">
    <table><thead><tr><th scope="col">Account</th><th scope="col" class="n">Amount</th></tr></thead><tbody>
    ${[['Income', 'Revenue', selected.revenue], ['Cost of Goods Sold', 'Cost of sales', selected.costOfSales], ['Expense', 'Operating expenses', selected.operatingExpenses]].map(([type, label, subtotal]) => {
      const accounts = selected.breakdown.filter(account => account.type === type)
        .sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }) || a.name.localeCompare(b.name));
      return `<tr><th scope="row">${label}</th><td class="n"><b>${amount(subtotal)}</b></td></tr>` +
        accounts.map(account => `<tr><td>${esc([account.code, account.name].filter(Boolean).join(' '))}</td><td class="n">${amount(account.amount)}</td></tr>`).join('');
    }).join('')}<tr><th scope="row">Net income</th><td class="n"><b>${amount(selected.netIncome)}</b></td></tr></tbody></table></div></div>` : '';

  return report + period + `<div class="panel"><div class="tbl-wrap"><table>
    <thead><tr><th scope="col">Restaurant</th><th scope="col" class="n">Revenue</th><th scope="col" class="n">Expenses</th>
    <th scope="col" class="n">Net income</th><th scope="col" class="n">Net margin</th><th scope="col">Period status</th>
    </tr></thead><tbody>${rows}</tbody>${total}</table></div></div>` + detail;
}

function bindRestaurantGroup(main) {
  const form = $('#restaurantPeriod', main);
  const back = $('[data-rg-back]', main);
  back.onclick = showCompanies;
  form.oninput = () => {
    restaurantGroup.draftFrom = form.elements.from.value;
    restaurantGroup.draftTo = form.elements.to.value;
  };
  form.onsubmit = event => {
    event.preventDefault();
    restaurantGroup.from = form.elements.from.value;
    restaurantGroup.to = form.elements.to.value;
    restaurantGroup.data = null;
    restaurantGroup.error = '';
    renderMain();
    loadRestaurantGroup();
  };
  $$('[data-rg-location]', main).forEach(button => {
    button.onclick = () => {
      restaurantGroup.location = button.dataset.rgLocation;
      loadRestaurantGroup();
    };
  });
  $$('[data-rg-unlock]', main).forEach(button => {
    button.onclick = async () => {
      if (await askCode(button.dataset.rgUnlock)) loadRestaurantGroup();
    };
  });
}

async function configureRestaurantGroup(firm) {
  const url = '/api/firms/' + encodeURIComponent(firm.id) + '/restaurant-group';
  let companies;
  try { ({ companies } = await api('GET', url)); }
  catch (error) { return toast(error.message, true); }
  const choices = companies.sort((a, b) => a.name.localeCompare(b.name)).map(company =>
    `<label class="check"><input type="checkbox" name="companies" value="${esc(company.id)}" ${company.selected ? 'checked' : ''}> ${esc(company.name)}</label>`).join('');
  const form = openModal('Restaurant Group Dashboard', `<p>Choose the companies to show for ${esc(firm.name)}. Users see only companies they already have access to. Clear the selection to turn off the dashboard.</p>
    <div class="fields">${choices || '<div class="muted">This firm has no active companies.</div>'}</div>`, saveFoot(false));
  form.onsubmit = async event => {
    event.preventDefault();
    const submit = $('button[type=submit]', form);
    submit.disabled = true;
    try {
      const result = await api('PUT', url, { companies: new FormData(form).getAll('companies') });
      firm.restaurantGroupCount = result.count;
      closeModal();
      if (S.view === 'firms') renderMain();
      toast(result.count ? 'Restaurant group saved' : 'Restaurant dashboard turned off');
    } catch (error) { toast(error.message, true); }
    finally { submit.disabled = false; }
  };
}
