import { db } from './db.js';
import { randomUUID } from 'node:crypto';
import { PreparationStation } from '../../core/domain/enums/index.js';

export async function seedDatabase(): Promise<{
  branchId: string;
  tableCount: number;
  productCount: number;
  inventoryCount: number;
}> {
  console.log('[Seed] Starting database seeding...');
  await db.initialize();

  // Check if branch already exists
  const existingBranch = await db.query(`SELECT id FROM branches LIMIT 1`);
  if (existingBranch.rows.length > 0) {
    console.log('[Seed] Database is already seeded. Skipping.');
    const branchId = existingBranch.rows[0].id;
    return { branchId, tableCount: 10, productCount: 8, inventoryCount: 9 };
  }

  // 1. Create Main Branch
  const branchId = randomUUID();
  await db.query(
    `INSERT INTO branches (id, name, tax_number, tax_office, is_active, created_at)
     VALUES ($1, $2, $3, $4, TRUE, NOW())`,
    [branchId, 'Kadıköy Rıhtım Şubesi', '1234567890', 'Kadıköy Vergi Dairesi']
  );
  console.log(`[Seed] Created Branch: Kadıköy Rıhtım Şubesi (${branchId})`);

  // 2. Create Dining Tables (6 Salon, 4 Teras)
  const tables = [
    { number: 'Salon-1', section: 'Ana Salon', capacity: 2, pos_x: 50, pos_y: 50 },
    { number: 'Salon-2', section: 'Ana Salon', capacity: 4, pos_x: 120, pos_y: 50 },
    { number: 'Salon-3', section: 'Ana Salon', capacity: 4, pos_x: 190, pos_y: 50 },
    { number: 'Salon-4', section: 'Ana Salon', capacity: 6, pos_x: 260, pos_y: 50 },
    { number: 'Salon-5', section: 'Ana Salon', capacity: 8, pos_x: 330, pos_y: 50 },
    { number: 'Salon-6', section: 'Ana Salon', capacity: 2, pos_x: 400, pos_y: 50 },
    { number: 'Teras-1', section: 'Teras', capacity: 4, pos_x: 50, pos_y: 200 },
    { number: 'Teras-2', section: 'Teras', capacity: 4, pos_x: 120, pos_y: 200 },
    { number: 'Teras-3', section: 'Teras', capacity: 6, pos_x: 190, pos_y: 200 },
    { number: 'Teras-4', section: 'Teras', capacity: 4, pos_x: 260, pos_y: 200 },
  ];

  for (const t of tables) {
    await db.query(
      `INSERT INTO dining_tables (id, branch_id, table_number, section, capacity, current_status, pos_x, pos_y)
       VALUES ($1, $2, $3, $4, $5, 'AVAILABLE', $6, $7)`,
      [randomUUID(), branchId, t.number, t.section, t.capacity, t.pos_x, t.pos_y]
    );
  }
  console.log(`[Seed] Created ${tables.length} dining tables across Ana Salon and Teras.`);

  // 3. Create Categories
  const categories = [
    { id: randomUUID(), name: 'Burgerler', sort_order: 1 },
    { id: randomUUID(), name: 'Başlangıçlar & Yan Lezzetler', sort_order: 2 },
    { id: randomUUID(), name: 'Tatlılar', sort_order: 3 },
    { id: randomUUID(), name: 'İçecekler', sort_order: 4 },
  ];

  for (const c of categories) {
    await db.query(
      `INSERT INTO categories (id, name, sort_order, is_active) VALUES ($1, $2, $3, TRUE)`,
      [c.id, c.name, c.sort_order]
    );
  }
  console.log(`[Seed] Created ${categories.length} categories.`);

  // 4. Create Inventory Items (Raw materials)
  const rawItems = [
    { key: 'beef', sku: 'RAW-BEEF', name: 'Dana Kıyma (%80 Yağsız)', uom: 'KG', stock: 50.0, cost: 480.0 },
    { key: 'chicken', sku: 'RAW-CHICKEN', name: 'Tavuk Göğüs Fileto', uom: 'KG', stock: 30.0, cost: 190.0 },
    { key: 'bun', sku: 'RAW-BUN', name: 'Brioche Burger Ekmeği', uom: 'ADET', stock: 250.0, cost: 12.0 },
    { key: 'cheddar', sku: 'RAW-CHEDDAR', name: 'Dilimli Cheddar Peyniri', uom: 'KG', stock: 20.0, cost: 380.0 },
    { key: 'potato', sku: 'RAW-POTATO', name: 'Dondurulmuş Parmak Patates', uom: 'KG', stock: 80.0, cost: 65.0 },
    { key: 'onion', sku: 'RAW-ONION', name: 'Dondurulmuş Çıtır Soğan Halkası', uom: 'KG', stock: 40.0, cost: 75.0 },
    { key: 'cheesecake', sku: 'RAW-CAKE', name: 'San Sebastian Dilimi', uom: 'ADET', stock: 35.0, cost: 85.0 },
    { key: 'yogurt', sku: 'RAW-YOGURT', name: 'Köy Yoğurdu', uom: 'KG', stock: 30.0, cost: 55.0 },
    { key: 'coke', sku: 'RAW-COKE', name: 'Coca-Cola Zero 330ml Kutu', uom: 'ADET', stock: 120.0, cost: 25.0 },
  ];

  const inventoryMap = new Map<string, string>();
  for (const raw of rawItems) {
    const rawId = randomUUID();
    inventoryMap.set(raw.key, rawId);
    await db.query(
      `INSERT INTO inventory_items (id, branch_id, sku, name, unit_of_measure, current_stock, safety_threshold, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, 10.0, $7)`,
      [rawId, branchId, raw.sku, raw.name, raw.uom, raw.stock, raw.cost]
    );
  }
  console.log(`[Seed] Created ${rawItems.length} inventory raw items.`);

  // 5. Create 8 Products & Recipes (BOM)
  const products = [
    {
      sku: 'BUR-01',
      barcode: '8680001001',
      name: 'Klasik Gurme Burger',
      catId: categories[0].id,
      price: 320.0,
      tax: 10.0,
      station: PreparationStation.GRILL,
      prepTime: 12,
      ingredients: [
        { invKey: 'bun', qty: 1.0, waste: 0.0 },
        { invKey: 'beef', qty: 0.16, waste: 5.0 },
      ],
    },
    {
      sku: 'BUR-02',
      barcode: '8680001002',
      name: 'Double Cheddar Burger',
      catId: categories[0].id,
      price: 420.0,
      tax: 10.0,
      station: PreparationStation.GRILL,
      prepTime: 15,
      ingredients: [
        { invKey: 'bun', qty: 1.0, waste: 0.0 },
        { invKey: 'beef', qty: 0.32, waste: 5.0 },
        { invKey: 'cheddar', qty: 0.04, waste: 0.0 },
      ],
    },
    {
      sku: 'BUR-03',
      barcode: '8680001003',
      name: 'Çıtır Tavuk Burger',
      catId: categories[0].id,
      price: 280.0,
      tax: 10.0,
      station: PreparationStation.GRILL,
      prepTime: 10,
      ingredients: [
        { invKey: 'bun', qty: 1.0, waste: 0.0 },
        { invKey: 'chicken', qty: 0.18, waste: 4.0 },
      ],
    },
    {
      sku: 'SNK-01',
      barcode: '8680002001',
      name: 'Baharatlı Patates Kızartması',
      catId: categories[1].id,
      price: 120.0,
      tax: 10.0,
      station: PreparationStation.OVEN,
      prepTime: 8,
      ingredients: [{ invKey: 'potato', qty: 0.25, waste: 8.0 }],
    },
    {
      sku: 'SNK-02',
      barcode: '8680002002',
      name: 'Çıtır Soğan Halkası (8 Adet)',
      catId: categories[1].id,
      price: 110.0,
      tax: 10.0,
      station: PreparationStation.OVEN,
      prepTime: 7,
      ingredients: [{ invKey: 'onion', qty: 0.2, waste: 5.0 }],
    },
    {
      sku: 'DES-01',
      barcode: '8680003001',
      name: 'San Sebastian Cheesecake',
      catId: categories[2].id,
      price: 190.0,
      tax: 10.0,
      station: PreparationStation.COLD,
      prepTime: 4,
      ingredients: [{ invKey: 'cheesecake', qty: 1.0, waste: 0.0 }],
    },
    {
      sku: 'DRK-01',
      barcode: '8680004001',
      name: 'Ev Yapımı Köy Ayranı (300ml)',
      catId: categories[3].id,
      price: 45.0,
      tax: 10.0,
      station: PreparationStation.BAR,
      prepTime: 3,
      ingredients: [{ invKey: 'yogurt', qty: 0.15, waste: 2.0 }],
    },
    {
      sku: 'DRK-02',
      barcode: '8680004002',
      name: 'Coca-Cola Zero 330ml',
      catId: categories[3].id,
      price: 60.0,
      tax: 10.0,
      station: PreparationStation.BAR,
      prepTime: 2,
      ingredients: [{ invKey: 'coke', qty: 1.0, waste: 0.0 }],
    },
  ];

  for (const prod of products) {
    const prodId = randomUUID();
    await db.query(
      `INSERT INTO products (
        id, category_id, sku, barcode, name, base_price, tax_rate,
        preparation_station, standard_prep_time_minutes, is_available
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)`,
      [
        prodId,
        prod.catId,
        prod.sku,
        prod.barcode,
        prod.name,
        prod.price,
        prod.tax,
        prod.station,
        prod.prepTime,
      ]
    );

    // Create Recipe
    const recipeId = randomUUID();
    await db.query(
      `INSERT INTO recipes (id, product_id, yield_quantity, instructions)
       VALUES ($1, $2, 1.0, 'Standart porsiyon reçete')`,
      [recipeId, prodId]
    );

    for (const ing of prod.ingredients) {
      const invItemId = inventoryMap.get(ing.invKey)!;
      await db.query(
        `INSERT INTO recipe_ingredients (id, recipe_id, inventory_item_id, quantity_needed, waste_percentage)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), recipeId, invItemId, ing.qty, ing.waste]
      );
    }
  }

  console.log(`[Seed] Created ${products.length} products with associated recipes and ingredients.`);
  console.log('[Seed] Database seeding completed successfully.');

  return {
    branchId,
    tableCount: tables.length,
    productCount: products.length,
    inventoryCount: rawItems.length,
  };
}

if (process.argv[1]?.endsWith('seed.ts')) {
  seedDatabase()
    .then(() => {
      db.close();
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Seed] Error during seeding:', err);
      process.exit(1);
    });
}
