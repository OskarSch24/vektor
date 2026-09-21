import { dbEngine } from './dbEngine';
import { DatabaseMetadata } from '../types/sqlite';

export async function loadSampleDatabase(
  shouldAdopt: () => boolean = () => true
): Promise<DatabaseMetadata | null> {
  const SQL = await dbEngine.init();
  const db = new SQL.Database();

  const schemaScript = `
    -- Categories Table
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL,
      description TEXT,
      icon TEXT
    );

    -- Devices Table (Apple Products)
    CREATE TABLE devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      model_identifier TEXT UNIQUE,
      chipset TEXT,
      base_storage_gb INTEGER,
      price_usd REAL NOT NULL,
      stock_quantity INTEGER DEFAULT 0,
      rating REAL CHECK (rating >= 0 AND rating <= 5.0),
      specs_json TEXT,
      released_year INTEGER,
      is_available BOOLEAN DEFAULT 1
    );

    -- Customers Table
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      city TEXT,
      country TEXT,
      membership_tier TEXT CHECK (membership_tier IN ('Standard', 'Silver', 'Gold', 'Titanium')),
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Orders Table
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      order_number TEXT UNIQUE NOT NULL,
      status TEXT CHECK (status IN ('Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled')),
      total_amount REAL NOT NULL,
      payment_method TEXT,
      order_date DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Order Items Table
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      device_id INTEGER REFERENCES devices(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price REAL NOT NULL
    );

    -- Reviews Table
    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
      customer_id INTEGER REFERENCES customers(id),
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      title TEXT,
      comment TEXT,
      helpful_votes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance
    CREATE INDEX idx_devices_category ON devices(category_id);
    CREATE INDEX idx_orders_customer ON orders(customer_id);
    CREATE INDEX idx_order_items_order ON order_items(order_id);
    CREATE INDEX idx_order_items_device ON order_items(device_id);
    CREATE INDEX idx_reviews_device ON reviews(device_id);

    -- Useful Analytical View
    CREATE VIEW v_sales_overview AS
    SELECT 
      d.id AS device_id,
      d.name AS device_name,
      c.name AS category_name,
      d.price_usd,
      COALESCE(SUM(oi.quantity), 0) AS units_sold,
      COALESCE(SUM(oi.quantity * oi.unit_price), 0.0) AS total_revenue_usd,
      COUNT(DISTINCT o.id) AS order_count
    FROM devices d
    LEFT JOIN categories c ON d.category_id = c.id
    LEFT JOIN order_items oi ON d.id = oi.device_id
    LEFT JOIN orders o ON oi.order_id = o.id AND o.status != 'Cancelled'
    GROUP BY d.id;

    -- Data Insertion: Categories
    INSERT INTO categories (id, name, slug, description, icon) VALUES
      (1, 'iPhone', 'iphone', 'Leistungsstarke Smartphones mit iOS', 'Smartphone'),
      (2, 'MacBook', 'macbook', 'Prozessoren der M-Serie für Höchstleistung', 'Laptop'),
      (3, 'iPad', 'ipad', 'Vielseitige Tablets für Kreative und Pros', 'Tablet'),
      (4, 'Apple Watch', 'watch', 'Fortschrittliche Gesundheits- und Fitnesstracker', 'Watch'),
      (5, 'Vision', 'vision', 'Spatial Computing & immersive Erlebnisse', 'Glasses'),
      (6, 'Audio', 'audio', 'AirPods und HiFi-Sound-Systeme', 'Headphones');

    -- Data Insertion: Devices
    INSERT INTO devices (id, category_id, name, model_identifier, chipset, base_storage_gb, price_usd, stock_quantity, rating, specs_json, released_year, is_available) VALUES
      (1, 1, 'iPhone 16 Pro Max', 'iPhone17,2', 'A18 Pro', 256, 1199.00, 85, 4.9, '{"display": "6.9 Super Retina XDR OLED", "camera": "48MP Fusion + 5x Telephoto", "color": "Desert Titanium", "weight_grams": 227}', 2024, 1),
      (2, 1, 'iPhone 16', 'iPhone17,1', 'A18', 128, 799.00, 140, 4.7, '{"display": "6.1 Super Retina XDR OLED", "camera": "48MP Fusion Dual", "color": "Ultramarine", "weight_grams": 170}', 2024, 1),
      (3, 2, 'MacBook Pro 16" M4 Max', 'Mac16,6', 'Apple M4 Max', 1024, 3499.00, 32, 4.95, '{"cpu_cores": 16, "gpu_cores": 40, "ram_gb": 48, "display": "Liquid Retina XDR Mini-LED 120Hz"}', 2024, 1),
      (4, 2, 'MacBook Air 15" M3', 'Mac15,13', 'Apple M3', 512, 1299.00, 64, 4.8, '{"cpu_cores": 8, "gpu_cores": 10, "ram_gb": 16, "display": "15.3 Liquid Retina IPS"}', 2024, 1),
      (5, 3, 'iPad Pro 13" M4', 'iPad16,4', 'Apple M4', 256, 1299.00, 45, 4.85, '{"display": "Ultra Retina XDR Tandem OLED", "thickness_mm": 5.1, "pencil_support": "Apple Pencil Pro"}', 2024, 1),
      (6, 4, 'Apple Watch Ultra 2', 'Watch7,5', 'Apple S9 SiP', 64, 799.00, 50, 4.9, '{"casing": "Grade 5 Titanium", "water_resistance_m": 100, "battery_hours": 72}', 2024, 1),
      (7, 4, 'Apple Watch Series 10', 'Watch7,1', 'Apple S10 SiP', 64, 399.00, 110, 4.75, '{"casing": "Jet Black Aluminum", "display": "Wide-angle OLED", "speaker": "Direct media playback"}', 2024, 1),
      (8, 5, 'Apple Vision Pro', 'RealityDevice1,1', 'Apple M2 + R1', 512, 3499.00, 18, 4.6, '{"display": "23 Million Pixels Micro-OLED", "refresh_rate": 100, "tracking": "Spatial Audio + Eye Tracking"}', 2024, 1),
      (9, 6, 'AirPods Max (USB-C)', 'AirPodsMax2,1', 'Apple H1', 0, 549.00, 72, 4.7, '{"charging": "USB-C", "anc": "Active Noise Cancellation", "lossless": "Yes with 3.5mm adapter"}', 2024, 1),
      (10, 6, 'AirPods Pro 2', 'AirPodsPro2,2', 'Apple H2', 0, 249.00, 195, 4.9, '{"anc": "Active Noise Cancellation 2x", "features": "Hearing Aid Feature + Adaptive Audio"}', 2023, 1);

    -- Data Insertion: Customers
    INSERT INTO customers (id, full_name, email, city, country, membership_tier, registered_at) VALUES
      (1, 'Sophie Lindemann', 'sophie.lindemann@berlin-tech.de', 'Berlin', 'Deutschland', 'Titanium', '2023-04-12 10:20:00'),
      (2, 'Marc Dubois', 'marc.dubois@paris-art.fr', 'Paris', 'Frankreich', 'Gold', '2023-06-18 14:45:00'),
      (3, 'Elena Rossi', 'elena.rossi@milano-design.it', 'Mailand', 'Italien', 'Titanium', '2023-08-01 09:12:00'),
      (4, 'Alexander Vance', 'alexander.v@vance-systems.co.uk', 'London', 'UK', 'Gold', '2023-11-20 16:30:00'),
      (5, 'Lukas Huber', 'lukas.huber@zurich-quant.ch', 'Zürich', 'Schweiz', 'Silver', '2024-01-05 11:05:00'),
      (6, 'Clara Jensen', 'clara.jensen@cph-creative.dk', 'Kopenhagen', 'Dänemark', 'Standard', '2024-02-14 18:22:00'),
      (7, 'Maximilian Koch', 'm.koch@munich-cloud.de', 'München', 'Deutschland', 'Titanium', '2024-03-29 08:50:00'),
      (8, 'Mia Virtanen', 'mia.v@helsinki-dev.fi', 'Helsinki', 'Finnland', 'Gold', '2024-05-11 13:10:00');

    -- Data Insertion: Orders
    INSERT INTO orders (id, customer_id, order_number, status, total_amount, payment_method, order_date) VALUES
      (1, 1, 'ORD-2024-1001', 'Delivered', 4698.00, 'Apple Pay', '2024-06-10 11:32:00'),
      (2, 2, 'ORD-2024-1002', 'Delivered', 1299.00, 'Kreditkarte', '2024-06-25 15:10:00'),
      (3, 3, 'ORD-2024-1003', 'Delivered', 3499.00, 'Apple Pay', '2024-07-04 19:40:00'),
      (4, 4, 'ORD-2024-1004', 'Delivered', 249.00, 'PayPal', '2024-07-15 09:15:00'),
      (5, 5, 'ORD-2024-1005', 'Shipped', 1998.00, 'Apple Pay', '2024-08-02 14:00:00'),
      (6, 7, 'ORD-2024-1006', 'Processing', 4298.00, 'Kreditkarte', '2024-08-19 16:55:00'),
      (7, 8, 'ORD-2024-1007', 'Delivered', 799.00, 'Apple Pay', '2024-08-28 12:20:00');

    -- Data Insertion: Order Items
    INSERT INTO order_items (id, order_id, device_id, quantity, unit_price) VALUES
      (1, 1, 3, 1, 3499.00),
      (2, 1, 1, 1, 1199.00),
      (3, 2, 5, 1, 1299.00),
      (4, 3, 8, 1, 3499.00),
      (5, 4, 10, 1, 249.00),
      (6, 5, 1, 1, 1199.00),
      (7, 5, 6, 1, 799.00),
      (8, 6, 3, 1, 3499.00),
      (9, 6, 6, 1, 799.00),
      (10, 7, 6, 1, 799.00);

    -- Data Insertion: Reviews
    INSERT INTO reviews (id, device_id, customer_id, rating, title, comment, helpful_votes, created_at) VALUES
      (1, 3, 1, 5, 'Absolute Spitzenleistung für Rendering & ML', 'Der M4 Max bewältigt lokale LLM-Inferenz und 8K ProRes Videoschnitt ohne wahrnehmbare Lüftergeräusche. Beste Tastatur und Display.', 42, '2024-06-18 12:00:00'),
      (2, 1, 1, 5, 'Wunderschönes Titan-Finish & brillante Tele-Kamera', 'Der 5x optische Zoom und die Akkulaufzeit sind hervorragend. Die Kamerasteuerungstaste ist nach kurzer Eingewöhnung genial.', 28, '2024-06-20 14:15:00'),
      (3, 8, 3, 4, 'Blick in die Zukunft des Spatial Computing', 'Die visuelle Schärfe der Micro-OLEDs ist atemberaubend. Persona und Eyetracking funktionieren magisch. Etwas schwer auf Dauer.', 67, '2024-07-10 18:30:00'),
      (4, 10, 4, 5, 'Perfekt für Reisen und Pendeln', 'Die Geräuschunterdrückung filtert Bahn- und Flugzeuglärm fast restlos weg. Das Case mit Lautsprecher zum Wiederfinden ist Gold wert.', 15, '2024-07-22 08:45:00'),
      (5, 6, 8, 5, 'Unverwüstlich in den Alpen', 'Batterie hält locker ein ganzes Wochenende bei aktivem GPS-Tracking. Das Titangehäuse steckt jeden Felskontakt weg.', 31, '2024-08-30 17:10:00');
  `;

  let binaryData: Uint8Array;
  try {
    db.exec(schemaScript);
    binaryData = db.export();
  } finally {
    // The scratch database has served its purpose; without this its WebAssembly
    // heap allocation would leak on every click of "Demo DB".
    db.close();
  }

  return dbEngine.loadDatabase(binaryData, 'Apple_Ecosystem_Store.sqlite', shouldAdopt);
}
