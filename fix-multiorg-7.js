const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Add a helper function to get SKU-based product cost for an order
const helperCode = `
function getSkuBasedProductCost(items, orgId) {
  if (!orgId || orgId === 1) return null; // Noriks uses detectProduct
  const skuCosts = getOrgSettings(orgId, 'sku_costs');
  if (!Object.keys(skuCosts).length) return null;
  let totalCost = 0;
  for (const item of (items || [])) {
    const sku = (item.sku || '').toUpperCase();
    const qty = item.quantity || 1;
    const cost = parseFloat(skuCosts[sku]) || 0;
    totalCost += cost * qty;
  }
  return totalCost;
}
`;

// Insert after getOrgMetaConfig
code = code.replace(
  'function getOrgProductCosts(orgId) {',
  helperCode + '\nfunction getOrgProductCosts(orgId) {'
);
console.log('1. Added getSkuBasedProductCost helper');

// Now modify the sync profit calculation to use SKU costs for non-Noriks orgs
// Find the product cost calculation block in syncCountry
// Current code (around line 680):
//   const productCost = (totalTshirts * PRODUCT_COSTS.tshirt) + ...
//   const shippingCost = SHIPPING_COSTS[country] || 4;

// Replace with org-aware version
code = code.replace(
  `const productCost = (totalTshirts * PRODUCT_COSTS.tshirt) + (totalBoxers * PRODUCT_COSTS.boxers) + (totalSocks * PRODUCT_COSTS.socks);

  // Shipping ALWAYS applied per order (matches dash behavior)
  const SHIPPING_COSTS = { HR: 4.5, CZ: 3.8, PL: 4, SK: 3.8, HU: 4, GR: 5, IT: 6, SI: 4.5, RO: 4.5 };
  const shippingCost = SHIPPING_COSTS[country] || 4;
  const effectiveProductCost = productCost * (1 - rejRate);`,
  `// Product cost: SKU-based for non-Noriks orgs, detectProduct for Noriks
  let productCost;
  const skuCost = getSkuBasedProductCost(order.line_items, syncOrgId);
  if (skuCost !== null) {
    productCost = skuCost;
  } else {
    productCost = (totalTshirts * PRODUCT_COSTS.tshirt) + (totalBoxers * PRODUCT_COSTS.boxers) + (totalSocks * PRODUCT_COSTS.socks);
  }

  // Shipping: use org-specific costs if available, else hardcoded defaults
  const DEFAULT_SHIPPING = { HR: 4.5, CZ: 3.8, PL: 4, SK: 3.8, HU: 4, GR: 5, IT: 6, SI: 4.5, RO: 4.5 };
  let shippingCost;
  if (syncOrgId !== 1) {
    const orgShipping = getOrgSettings(syncOrgId, 'shipping_costs2');
    shippingCost = parseFloat(orgShipping[country]) || DEFAULT_SHIPPING[country] || 4;
  } else {
    shippingCost = DEFAULT_SHIPPING[country] || 4;
  }
  const effectiveProductCost = productCost * (1 - rejRate);`
);
console.log('2. Product cost + shipping now org-aware in sync');

// Also need to make rejRate org-aware in sync
// Currently: const { rej } = getRates2();
// Find where rejRate is set in the sync function
// It's: const rejRate = (rej[country] || 0) / 100;
// getRates2 is already fixed to accept orgId, but the call in sync might not pass it

// Check if syncCountry calls getRates2
fs.writeFileSync('server.js', code);
console.log('\n=== Done ===');
