import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const starterProducts = [
  { id: 1, name: "Wireless Headphones", category: "Electronics", price: 1499, emoji: "🎧", rating: 4.5, tag: "Popular" },
  { id: 2, name: "Smart Watch", category: "Electronics", price: 2199, emoji: "⌚", rating: 4.3, tag: "Trending" },
  { id: 3, name: "Everyday Backpack", category: "Fashion", price: 899, emoji: "🎒", rating: 4.4, tag: "Best value" },
  { id: 4, name: "Cotton T-shirt", category: "Fashion", price: 499, emoji: "👕", rating: 4.2, tag: "New" },
  { id: 5, name: "Desk Lamp", category: "Home", price: 699, emoji: "💡", rating: 4.1, tag: "" },
  { id: 6, name: "Coffee Mug Set", category: "Home", price: 349, emoji: "☕", rating: 4.6, tag: "" },
  { id: 7, name: "Fresh Fruit Box", category: "Grocery", price: 399, emoji: "🍎", rating: 4.5, tag: "Fresh" },
  { id: 8, name: "Skin Care Kit", category: "Beauty", price: 799, emoji: "🧴", rating: 4.2, tag: "" },
];
const money = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

function App() {
  const [products, setProducts] = useState(() => {
    try { return JSON.parse(localStorage.getItem("shopsphere-products")) || starterProducts; } catch { return starterProducts; }
  });
  const [cart, setCart] = useState(() => {
    try { return JSON.parse(localStorage.getItem("shopsphere-cart")) || {}; } catch { return {}; }
  });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [cartOpen, setCartOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", category: "Electronics", price: "", emoji: "🛍️" });

  useEffect(() => { localStorage.setItem("shopsphere-products", JSON.stringify(products)); }, [products]);
  useEffect(() => { localStorage.setItem("shopsphere-cart", JSON.stringify(cart)); }, [cart]);

  const categories = ["All", "Electronics", "Fashion", "Home", "Grocery", "Beauty"];
  const visible = useMemo(() => products.filter(p => (category === "All" || p.category === category) && p.name.toLowerCase().includes(query.toLowerCase())), [products, category, query]);
  const cartItems = products.filter(p => Number(cart[p.id]) > 0);
  const cartCount = Object.values(cart).reduce((a, b) => a + Number(b || 0), 0);
  const total = cartItems.reduce((sum, p) => sum + p.price * Number(cart[p.id]), 0);

  function changeQty(id, delta) {
    setCart(prev => { const next = { ...prev, [id]: Math.max(0, (Number(prev[id]) || 0) + delta) }; if (!next[id]) delete next[id]; return next; });
  }
  function addProduct(e) {
    e.preventDefault();
    if (!draft.name.trim() || !Number(draft.price) || Number(draft.price) <= 0) return;
    setProducts(prev => [{ id: Date.now(), name: draft.name.trim(), category: draft.category, price: Number(draft.price), emoji: draft.emoji || "🛍️", rating: 4.3, tag: "Added" }, ...prev]);
    setDraft({ name: "", category: "Electronics", price: "", emoji: "🛍️" });
  }
  function updatePrice(id, value) {
    const price = Number(value);
    if (!Number.isFinite(price) || price <= 0) return;
    setProducts(prev => prev.map(p => p.id === id ? { ...p, price } : p));
  }
  function removeProduct(id) { setProducts(prev => prev.filter(p => p.id !== id)); setCart(prev => { const n = { ...prev }; delete n[id]; return n; }); }

  return <div className="app">
    <header className="topbar"><a className="brand" href="#"><span className="brand-icon">S</span> ShopSphere</a>
      <div className="search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search products, brands and more" aria-label="Search products"/><button onClick={() => setQuery("")} aria-label="Clear search">×</button></div>
      <div className="actions"><button className="admin-btn" onClick={() => setAdminOpen(!adminOpen)}>⚙ Admin</button><button className="cart-btn" onClick={() => setCartOpen(true)}>🛒 Cart <b>{cartCount}</b></button></div>
    </header>
    <main>
      <section className="hero"><div className="hero-copy"><span className="eyebrow">SHOP SMART. LIVE BETTER.</span><h1>Everything you need.<br/><span>All in one place.</span></h1><p>Discover everyday essentials and great finds at prices you'll love.</p><a className="shop-cta" href="#products">Explore products <span>→</span></a></div><div className="hero-art"><div className="orbit orbit-one"></div><div className="orbit orbit-two"></div><div className="hero-bag">🛍️</div><span className="float f1">✨</span><span className="float f2">🎧</span><span className="float f3">👟</span></div></section>
      <section className="benefits"><div>🚚 <span><b>Fast delivery</b><small>At your doorstep</small></span></div><div>🔒 <span><b>Secure shopping</b><small>Shop with confidence</small></span></div><div>💬 <span><b>Customer support</b><small>We're here to help</small></span></div><div>💳 <span><b>Easy payments</b><small>Simple & convenient</small></span></div></section>
      <section id="products" className="products-section"><div className="section-heading"><div><span className="eyebrow">OUR COLLECTION</span><h2>Shop by category</h2></div><span className="count">{visible.length} products</span></div>
        <div className="categories">{categories.map(c => <button key={c} className={category === c ? "category active" : "category"} onClick={() => setCategory(c)}>{c}</button>)}</div>
        <div className="product-grid">{visible.map(p => <article className="product-card" key={p.id}><div className="product-image"><span className="product-emoji">{p.emoji}</span>{p.tag && <span className="tag">{p.tag}</span>}<button className="quick-add" onClick={() => changeQty(p.id, 1)} aria-label={"Add "+p.name}>＋</button></div><div className="product-info"><span className="product-category">{p.category}</span><h3>{p.name}</h3><div className="rating">★ {p.rating} <span>• In stock</span></div><div className="product-bottom"><strong>{money(p.price)}</strong><button onClick={() => changeQty(p.id, 1)}>Add to cart</button></div></div></article>)}
          {visible.length === 0 && <div className="empty">No products found. Try another search or category.</div>}
        </div></section>
    </main>
    <footer><a className="brand footer-brand"><span className="brand-icon">S</span> ShopSphere</a><span>Everyday shopping, made simple.</span><small>© {new Date().getFullYear()} ShopSphere</small></footer>
    {adminOpen && <div className="admin-panel"><div className="panel-head"><div><span className="eyebrow">STORE MANAGEMENT</span><h2>Admin panel</h2></div><button onClick={() => setAdminOpen(false)}>×</button></div><form onSubmit={addProduct} className="admin-form"><input placeholder="Product name" value={draft.name} onChange={e => setDraft({...draft,name:e.target.value})} required/><select value={draft.category} onChange={e => setDraft({...draft,category:e.target.value})}>{categories.slice(1).map(c=><option key={c}>{c}</option>)}</select><input type="number" min="1" placeholder="Price (₹)" value={draft.price} onChange={e => setDraft({...draft,price:e.target.value})} required/><input placeholder="Emoji" maxLength="4" value={draft.emoji} onChange={e => setDraft({...draft,emoji:e.target.value})}/><button className="primary" type="submit">Add product</button></form><div className="admin-list">{products.map(p=><div className="admin-row" key={p.id}><span>{p.emoji} {p.name}</span><input aria-label={"Update price for "+p.name} type="number" min="1" defaultValue={p.price} onBlur={e => updatePrice(p.id,e.target.value)}/><button className="remove" onClick={() => removeProduct(p.id)}>Remove</button></div>)}</div><p className="note">Demo admin panel: products and prices are saved in this browser only. No login or database is connected.</p></div>}
    {cartOpen && <div className="drawer-backdrop" onClick={() => setCartOpen(false)}><aside className="cart-drawer" onClick={e => e.stopPropagation()}><div className="panel-head"><div><span className="eyebrow">YOUR BAG</span><h2>Shopping cart ({cartCount})</h2></div><button onClick={() => setCartOpen(false)}>×</button></div>{cartItems.length === 0 ? <div className="empty-cart">🛒<p>Your cart is empty</p><button onClick={() => setCartOpen(false)}>Continue shopping</button></div> : <><div className="cart-list">{cartItems.map(p=><div className="cart-item" key={p.id}><div className="cart-emoji">{p.emoji}</div><div className="cart-details"><b>{p.name}</b><strong>{money(p.price)}</strong><div className="quantity"><button onClick={() => changeQty(p.id,-1)}>−</button><span>{cart[p.id]}</span><button onClick={() => changeQty(p.id,1)}>+</button></div></div></div>)}</div><div className="cart-summary"><div><span>Subtotal</span><b>{money(total)}</b></div><small>Taxes and delivery calculated at checkout.</small><button className="primary checkout" onClick={() => alert("Checkout demo only. Payment is not connected yet.")}>Proceed to checkout →</button></div></>}</aside></div>}
  </div>;
}

createRoot(document.getElementById("root")).render(<App />);
