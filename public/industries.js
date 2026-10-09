/* Starter charts of accounts by type of business.
 * Each industry adds accounts to the standard small-business chart (seed.js), and can rename a standard account
 * by using its code (4000 "Sales" becomes "Food sales" for a restaurant). Nothing is removed, so example data and
 * the rest of the app always find the standard accounts.
 * Each account: [code, name, type, detail, French name]. Shared by the server (new companies) and the browser
 * (the new company form, and adding an industry's accounts to an existing company).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.TallyIndustries = factory();
    // The type-of-business names in French, for the screens.
    if (typeof root.addFr === 'function') root.addFr(Object.fromEntries(Object.values(root.TallyIndustries.INDUSTRIES).map(i => [i.label, i.fr])));
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Accounts several industries share.
  const A = {
    inventory: ['1400', 'Inventory', 'Asset', '', 'Stocks'],
    vehicles: ['1510', 'Vehicles', 'Asset', 'capital', 'Véhicules'],
    tools: ['1520', 'Tools and equipment', 'Asset', 'capital', 'Outillage et matériel'],
    leasehold: ['1530', 'Leasehold improvements', 'Asset', 'capital', 'Améliorations locatives'],
    furniture: ['1540', 'Furniture and fixtures', 'Asset', 'capital', 'Mobilier et agencements'],
    deposits: ['2340', 'Customer deposits', 'Liability', '', 'Dépôts des clients'],
    giftCards: ['2310', 'Gift cards outstanding', 'Liability', '', 'Cartes-cadeaux en circulation'],
    tips: ['2350', 'Tips payable to staff', 'Liability', '', 'Pourboires à verser au personnel'],
    cardFees: ['6150', 'Card processing fees', 'Expense', '', 'Frais de traitement des cartes'],
    fuel: ['7010', 'Fuel', 'Expense', '', 'Carburant'],
    tools7: ['7300', 'Small tools and supplies', 'Expense', '', 'Petits outils et fournitures'],
    repairs: ['7310', 'Repairs and maintenance', 'Expense', '', 'Réparations et entretien'],
    cleaning: ['7320', 'Cleaning and janitorial', 'Expense', '', 'Nettoyage et conciergerie'],
    licences: ['7330', 'Licences and permits', 'Expense', '', 'Licences et permis'],
    wsib: ['7340', 'Workers’ compensation (WSIB, WorkSafeBC, CNESST)', 'Expense', '', 'Indemnisation des travailleurs (CNESST, WSIB)'],
    safety: ['7350', 'Safety equipment and clothing', 'Expense', '', 'Équipement et vêtements de sécurité'],
    uniforms: ['7355', 'Uniforms', 'Expense', '', 'Uniformes'],
    waste: ['7360', 'Waste removal', 'Expense', '', 'Enlèvement des déchets'],
    training: ['7370', 'Training and professional development', 'Expense', '', 'Formation et perfectionnement'],
    dues: ['7380', 'Memberships and dues', 'Expense', '', 'Cotisations et adhésions'],
    security: ['7390', 'Security and alarm', 'Expense', '', 'Sécurité et alarme'],
    freightIn: ['5090', 'Freight and shipping on purchases', 'Cost of Goods Sold', '', 'Transport sur achats'],
    shrink: ['5095', 'Inventory shrinkage and spoilage', 'Cost of Goods Sold', '', 'Pertes et freinte de stocks'],
    subs: ['5010', 'Subcontractors', 'Cost of Goods Sold', '', 'Sous-traitants'],
  };
  const restaurant = [
    ['4000', 'Food sales', 'Income', '', 'Ventes de nourriture'],
    ['4010', 'Beverage sales', 'Income', '', 'Ventes de boissons'],
    ['4020', 'Alcohol sales', 'Income', '', 'Ventes d’alcool'],
    ['4030', 'Catering revenue', 'Income', '', 'Revenus de traiteur'],
    ['4040', 'Delivery app sales (Uber Eats, DoorDash, SkipTheDishes)', 'Income', '', 'Ventes par applications de livraison'],
    ['5000', 'Food cost', 'Cost of Goods Sold', '', 'Coût de la nourriture'],
    ['5020', 'Beverage cost', 'Cost of Goods Sold', '', 'Coût des boissons'],
    ['5030', 'Alcohol cost', 'Cost of Goods Sold', '', 'Coût de l’alcool'],
    ['5040', 'Packaging and takeout supplies', 'Cost of Goods Sold', '', 'Emballages et fournitures pour emporter'],
    ['1400', 'Food and beverage inventory', 'Asset', '', 'Stocks de nourriture et de boissons'],
    A.leasehold, A.furniture, ['1520', 'Kitchen equipment', 'Asset', 'capital', 'Équipement de cuisine'],
    A.giftCards, A.tips, A.cardFees,
    ['6160', 'Delivery app commissions', 'Expense', '', 'Commissions des applications de livraison'],
    ['7300', 'Kitchen supplies and smallwares', 'Expense', '', 'Fournitures et petits articles de cuisine'],
    A.repairs, A.cleaning, A.licences, A.uniforms, A.waste,
    ['7365', 'Linen and laundry', 'Expense', '', 'Linge et blanchisserie'],
    A.shrink,
  ];
  const INDUSTRIES = {
    general: { label: 'General small business', fr: 'Petite entreprise (général)', accounts: [] },
    restaurant: { label: 'Restaurant, café or bar', fr: 'Restaurant, café ou bar', accounts: restaurant },
    pizza: { label: 'Pizza or take-out restaurant', fr: 'Pizzeria ou restaurant pour emporter', accounts: [
      ...restaurant.filter(a => a[0] !== '4020' && a[0] !== '5030' && a[0] !== '7365'),
      ['4000', 'Pizza and food sales', 'Income', '', 'Ventes de pizzas et de nourriture'],
      ['4050', 'Delivery fees charged', 'Income', '', 'Frais de livraison facturés'],
      A.vehicles, A.fuel,
      ['7020', 'Delivery driver costs', 'Expense', '', 'Frais des livreurs'],
    ] },
    convenience: { label: 'Convenience store or gas bar', fr: 'Dépanneur ou poste d’essence', accounts: [
      ['4000', 'Merchandise sales', 'Income', '', 'Ventes de marchandises'],
      ['4010', 'Tobacco and vape sales', 'Income', '', 'Ventes de tabac et de produits de vapotage'],
      ['4030', 'Lottery commissions', 'Income', '', 'Commissions de loterie'],
      ['4040', 'Bill payment, ATM and money transfer commissions', 'Income', '', 'Commissions (paiement de factures, guichet, transferts)'],
      ['4050', 'Prepaid card and phone card commissions', 'Income', '', 'Commissions sur cartes prépayées'],
      ['4060', 'Fuel sales', 'Income', '', 'Ventes de carburant'],
      ['1400', 'Merchandise inventory', 'Asset', '', 'Stocks de marchandises'],
      ['2320', 'Lottery sales payable (OLG, Loto-Québec, BCLC)', 'Liability', '', 'Ventes de loterie à remettre'],
      ['5000', 'Merchandise purchases', 'Cost of Goods Sold', '', 'Achats de marchandises'],
      ['5020', 'Tobacco and vape purchases', 'Cost of Goods Sold', '', 'Achats de tabac et de produits de vapotage'],
      ['5030', 'Fuel purchases', 'Cost of Goods Sold', '', 'Achats de carburant'],
      A.shrink, A.leasehold, A.furniture, A.cardFees, A.repairs, A.licences, A.security, A.cleaning, A.waste,
    ] },
    retail: { label: 'Retail store', fr: 'Commerce de détail', accounts: [
      ['4000', 'Merchandise sales', 'Income', '', 'Ventes de marchandises'],
      ['4050', 'Returns and allowances', 'Income', '', 'Rendus et rabais'],
      ['1400', 'Merchandise inventory', 'Asset', '', 'Stocks de marchandises'],
      ['5000', 'Merchandise purchases', 'Cost of Goods Sold', '', 'Achats de marchandises'],
      A.freightIn, A.shrink, A.leasehold, A.furniture, A.giftCards, A.cardFees,
      ['7385', 'Packaging and bags', 'Expense', '', 'Emballages et sacs'],
      ['7395', 'Store supplies', 'Expense', '', 'Fournitures de magasin'],
      A.repairs, A.security,
    ] },
    ecommerce: { label: 'Online store', fr: 'Boutique en ligne', accounts: [
      ['4000', 'Online sales', 'Income', '', 'Ventes en ligne'],
      ['4010', 'Shipping charged to customers', 'Income', '', 'Frais d’expédition facturés'],
      ['4050', 'Returns and refunds', 'Income', '', 'Retours et remboursements'],
      ['1400', 'Inventory', 'Asset', '', 'Stocks'],
      ['1050', 'Payment processor balances (Shopify, Stripe, PayPal)', 'Asset', 'bank', 'Soldes des processeurs de paiement'],
      ['5000', 'Product cost', 'Cost of Goods Sold', '', 'Coût des produits'],
      ['5020', 'Shipping and fulfillment', 'Cost of Goods Sold', '', 'Expédition et exécution des commandes'],
      A.freightIn, A.shrink,
      ['6150', 'Payment processing fees', 'Expense', '', 'Frais de traitement des paiements'],
      ['6160', 'Marketplace fees (Amazon, Etsy, eBay)', 'Expense', '', 'Frais des plateformes de vente'],
      ['6710', 'Website and e-commerce platform', 'Expense', '', 'Site Web et plateforme de commerce électronique'],
      ['7385', 'Packaging supplies', 'Expense', '', 'Fournitures d’emballage'],
    ] },
    painter: { label: 'Painting contractor', fr: 'Entrepreneur en peinture', accounts: [
      ['4000', 'Painting revenue', 'Income', '', 'Revenus de peinture'],
      ['4010', 'Materials billed to customers', 'Income', '', 'Matériaux facturés aux clients'],
      ['5000', 'Paint and materials', 'Cost of Goods Sold', '', 'Peinture et matériaux'],
      A.subs,
      ['5020', 'Equipment rental (lifts, scaffolding)', 'Cost of Goods Sold', '', 'Location d’équipement (nacelles, échafaudages)'],
      A.vehicles, A.tools, A.deposits, A.fuel, A.tools7, A.wsib, A.safety, A.licences, A.training,
    ] },
    construction: { label: 'Construction or renovation', fr: 'Construction ou rénovation', accounts: [
      ['4000', 'Contract revenue', 'Income', '', 'Revenus de contrats'],
      ['4010', 'Change orders and extras', 'Income', '', 'Avenants et travaux supplémentaires'],
      ['1210', 'Holdbacks receivable', 'Asset', '', 'Retenues à recevoir'],
      ['2330', 'Holdbacks payable', 'Liability', '', 'Retenues à payer'],
      A.deposits,
      ['5000', 'Materials', 'Cost of Goods Sold', '', 'Matériaux'],
      A.subs,
      ['5020', 'Direct labour', 'Cost of Goods Sold', '', 'Main-d’œuvre directe'],
      ['5030', 'Equipment rental', 'Cost of Goods Sold', '', 'Location d’équipement'],
      ['5040', 'Permits and inspections', 'Cost of Goods Sold', '', 'Permis et inspections'],
      ['5050', 'Dump and disposal fees', 'Cost of Goods Sold', '', 'Frais de décharge et d’élimination'],
      A.vehicles, ['1520', 'Heavy equipment and tools', 'Asset', 'capital', 'Machinerie lourde et outillage'],
      A.fuel, A.tools7, A.wsib, A.safety,
      ['7375', 'Bonding and contractor insurance', 'Expense', '', 'Cautionnement et assurance d’entrepreneur'],
      A.training,
    ] },
    trades: { label: 'Electrician, plumber or HVAC', fr: 'Électricien, plombier ou CVC', accounts: [
      ['4000', 'Service and installation revenue', 'Income', '', 'Revenus de service et d’installation'],
      ['4010', 'Parts and materials billed', 'Income', '', 'Pièces et matériaux facturés'],
      ['4020', 'Service contracts', 'Income', '', 'Contrats de service'],
      ['1400', 'Parts inventory', 'Asset', '', 'Stocks de pièces'],
      ['5000', 'Parts and materials', 'Cost of Goods Sold', '', 'Pièces et matériaux'],
      A.subs, A.vehicles, A.tools, A.deposits, A.fuel, A.tools7, A.wsib, A.safety, A.licences, A.training,
    ] },
    cleaning: { label: 'Cleaning or landscaping', fr: 'Entretien ménager ou aménagement paysager', accounts: [
      ['4000', 'Cleaning and landscaping revenue', 'Income', '', 'Revenus d’entretien et d’aménagement'],
      ['4020', 'Seasonal contracts', 'Income', '', 'Contrats saisonniers'],
      ['5000', 'Supplies and materials', 'Cost of Goods Sold', '', 'Fournitures et matériaux'],
      A.subs, A.vehicles, A.tools, A.fuel, A.tools7, A.wsib, A.safety, A.uniforms,
    ] },
    trucking: { label: 'Trucking or delivery', fr: 'Camionnage ou livraison', accounts: [
      ['4000', 'Freight revenue', 'Income', '', 'Revenus de transport'],
      ['4010', 'Fuel surcharge revenue', 'Income', '', 'Revenus de supplément carburant'],
      ['1510', 'Trucks and trailers', 'Asset', 'capital', 'Camions et remorques'],
      ['5000', 'Fuel', 'Cost of Goods Sold', '', 'Carburant'],
      ['5010', 'Contract drivers and owner-operators', 'Cost of Goods Sold', '', 'Chauffeurs contractuels et propriétaires-exploitants'],
      ['5020', 'Tolls and scales', 'Cost of Goods Sold', '', 'Péages et pesées'],
      ['7015', 'Truck repairs and maintenance', 'Expense', '', 'Réparations et entretien des camions'],
      ['7330', 'Licences, permits and IFTA', 'Expense', '', 'Licences, permis et IFTA'],
      ['7375', 'Cargo and truck insurance', 'Expense', '', 'Assurance cargaison et camions'],
      A.wsib, A.safety,
    ] },
    salon: { label: 'Salon, spa or barber', fr: 'Salon de coiffure, spa ou barbier', accounts: [
      ['4000', 'Salon and spa services', 'Income', '', 'Services de salon et de spa'],
      ['4010', 'Retail product sales', 'Income', '', 'Ventes de produits'],
      ['4020', 'Chair or booth rental income', 'Income', '', 'Revenus de location de chaises'],
      ['1400', 'Retail product inventory', 'Asset', '', 'Stocks de produits'],
      ['5000', 'Retail product cost', 'Cost of Goods Sold', '', 'Coût des produits vendus'],
      ['5020', 'Salon and spa supplies', 'Cost of Goods Sold', '', 'Fournitures de salon et de spa'],
      A.leasehold, A.furniture, A.giftCards, A.tips, A.cardFees, A.licences, A.training, A.cleaning,
      ['7365', 'Laundry and towels', 'Expense', '', 'Blanchisserie et serviettes'],
    ] },
    professional: { label: 'Consulting or professional services', fr: 'Services-conseils ou professionnels', accounts: [
      ['4000', 'Fees earned', 'Income', '', 'Honoraires gagnés'],
      ['4010', 'Reimbursed expenses', 'Income', '', 'Dépenses refacturées'],
      ['2345', 'Retainers received in advance', 'Liability', '', 'Provisions reçues d’avance'],
      ['1210', 'Unbilled work in progress', 'Asset', '', 'Travaux en cours non facturés'],
      A.subs, A.training, A.dues,
      ['7390', 'Professional liability insurance', 'Expense', '', 'Assurance responsabilité professionnelle'],
      ['6710', 'Home office expenses', 'Expense', '', 'Frais de bureau à domicile'],
    ] },
    rental: { label: 'Rental property', fr: 'Immeuble locatif', accounts: [
      ['4000', 'Rental income', 'Income', '', 'Revenus de location'],
      ['4010', 'Parking, laundry and other income', 'Income', '', 'Stationnement, buanderie et autres revenus'],
      ['1600', 'Buildings', 'Asset', 'capital', 'Bâtiments'],
      ['1610', 'Land', 'Asset', 'capital', 'Terrains'],
      ['2340', 'Tenant deposits', 'Liability', '', 'Dépôts des locataires'],
      ['2410', 'Mortgage payable', 'Liability', '', 'Hypothèque à payer'],
      ['7400', 'Property taxes', 'Expense', '', 'Impôts fonciers'],
      ['7410', 'Property management fees', 'Expense', '', 'Frais de gestion immobilière'],
      ['7420', 'Condo fees', 'Expense', '', 'Frais de copropriété'],
      ['7430', 'Mortgage interest', 'Expense', '', 'Intérêts hypothécaires'],
      A.repairs, A.cleaning,
    ] },
    // Scrap yards and auto recyclers. Choosing it also turns on the Scrap yard add-on (plans.js ADDONS.scrapyard):
    // vehicle intake by VIN, purchase vouchers for sellers paid in cash, parts pulled from each car, and profit per vehicle.
    scrapyard: { label: 'Scrap yard or auto recycler', fr: 'Cour à ferraille ou recycleur automobile', addon: 'scrapyard', accounts: [
      ['4000', 'Scrap metal sales', 'Income', '', 'Ventes de ferraille'],
      ['4010', 'Used parts sales', 'Income', '', 'Ventes de pièces usagées'],
      ['4020', 'Catalytic converter sales', 'Income', '', 'Ventes de convertisseurs catalytiques'],
      ['4030', 'Whole vehicle sales', 'Income', '', 'Ventes de véhicules entiers'],
      ['4040', 'Towing and pickup fees charged', 'Income', '', 'Frais de remorquage et de collecte facturés'],
      ['1410', 'Vehicles in yard (inventory)', 'Asset', '', 'Véhicules dans la cour (stocks)'],
      ['1510', 'Tow trucks and vehicles', 'Asset', 'capital', 'Dépanneuses et véhicules'],
      ['1520', 'Yard equipment (loaders, crushers, scales)', 'Asset', 'capital', 'Équipement de cour (chargeuses, presses, balances)'],
      ['5000', 'Cost of vehicles processed', 'Cost of Goods Sold', '', 'Coût des véhicules traités'],
      ['5010', 'Scrap metal bought by weight', 'Cost of Goods Sold', '', 'Ferraille achetée au poids'],
      ['5020', 'Towing and transport of vehicles', 'Cost of Goods Sold', '', 'Remorquage et transport des véhicules'],
      ['5040', 'Environmental disposal (fluids, tires, batteries, refrigerant)', 'Cost of Goods Sold', '', 'Élimination environnementale (fluides, pneus, batteries, frigorigène)'],
      A.fuel, A.repairs, A.licences, A.wsib, A.safety, A.security, A.waste, A.cardFees,
      ['7345', 'Environmental compliance and permits', 'Expense', '', 'Conformité environnementale et permis'],
    ],
    // Things a yard sells (and buys) by weight or by the piece. qty on an invoice line is the weight.
    // Each: [name, income account code, purchase account code ('' = sold only), French name].
    items: [
      ['Shredded steel (per tonne)', '4000', '5010', 'Acier déchiqueté (la tonne)'],
      ['Heavy melting steel (per tonne)', '4000', '5010', 'Acier de fusion lourd (la tonne)'],
      ['Car bodies, flattened (per tonne)', '4000', '5010', 'Carcasses aplaties (la tonne)'],
      ['Aluminum (per lb)', '4000', '5010', 'Aluminium (la livre)'],
      ['Copper (per lb)', '4000', '5010', 'Cuivre (la livre)'],
      ['Car batteries (each)', '4000', '5010', 'Batteries d’auto (l’unité)'],
      ['Catalytic converter (each)', '4020', '', 'Convertisseur catalytique (l’unité)'],
      ['Used auto part', '4010', '', 'Pièce d’auto usagée'],
    ],
    // A field on invoices and sales receipts for the scale's weigh ticket number.
    fields: [{ label: 'Weigh ticket no.', fr: 'No de billet de pesée', sales: true, purchase: false }] },
  };
  /** The accounts an industry adds or renames ([] for none or an unknown key). */
  const accountsFor = key => {
    const m = new Map();
    for (const a of INDUSTRIES[key] ? INDUSTRIES[key].accounts : []) if (a) m.set(a[0], a); // a later one with the same code wins
    return [...m.values()];
  };
  return { INDUSTRIES, accountsFor };
});
