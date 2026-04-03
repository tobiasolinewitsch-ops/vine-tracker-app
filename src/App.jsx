import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from './supabase'
import * as XLSX from 'xlsx'

// ─── Constants ───
const MONTHS = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez']
const MONTHS_FULL = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember']
const STATUS_COLORS = { aktiv:'#22c55e', defekt:'#ef4444', verkauft:'#3b82f6', storniert:'#94a3b8', verschenkt:'#a855f7' }
const STATUS_LABELS = { aktiv:'Aktiv', defekt:'Defekt', verkauft:'Verkauft', storniert:'Storniert', verschenkt:'Verschenkt' }
const STATUS_ICONS = { aktiv:'✓', defekt:'✕', verkauft:'€', storniert:'⊘', verschenkt:'♡' }
const ABSCHLAG_OPTIONS = [
  { value: 0, label: '0%', desc: 'Kein Abschlag' },
  { value: 0.3, label: '30%', desc: 'Gering' },
  { value: 0.5, label: '50%', desc: 'Standard' },
  { value: 0.7, label: '70%', desc: 'Hoch' },
  { value: 1.0, label: '100%', desc: 'Komplett' },
]

const fmt = n => new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(n||0)
const fmtDate = d => d ? new Date(d).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}) : '–'
const fmtDateShort = d => d ? new Date(d).toLocaleDateString('de-DE',{day:'2-digit',month:'short'}) : '–'

function isSellable(item) {
  if (!item.versanddatum || item.status !== 'aktiv') return false
  const ship = new Date(item.versanddatum)
  const threshold = new Date()
  threshold.setMonth(threshold.getMonth() - 6)
  return ship <= threshold
}

function daysUntilSellable(item) {
  if (!item.versanddatum) return null
  const ship = new Date(item.versanddatum)
  const sellDate = new Date(ship)
  sellDate.setMonth(sellDate.getMonth() + 6)
  const now = new Date()
  const diff = Math.ceil((sellDate - now) / (1000 * 60 * 60 * 24))
  return diff > 0 ? diff : 0
}

function parseITIMDate(d) {
  if (!d) return null
  if (typeof d === 'number') {
    const date = new Date((d - 25569) * 86400 * 1000)
    return date.toISOString().split('T')[0]
  }
  const s = String(d).trim()
  if (s.includes('/')) { const [day,month,year] = s.split('/'); return `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}` }
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0,10)
  return null
}

// ─── Main App ───
export default function App() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [profileOpen, setProfileOpen] = useState(false)

  const [items, setItems] = useState([])
  const [settings, setSettings] = useState({ steuersatz: 0.35, wertminderung: 0.5, gebuehrenrate: 0 })
  const [view, setView] = useState('dashboard')
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('alle')
  const [sellableFilter, setSellableFilter] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState(null)
  const [toast, setToast] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reviewMode, setReviewMode] = useState(false)
  const [reviewIndex, setReviewIndex] = useState(0)

  const loadProfile = useCallback(async (uid) => {
    try {
      const { data } = await supabase.from('profiles').select('*').eq('id', uid).single()
      if (data?.is_blocked) {
        await supabase.auth.signOut()
        return null
      }
      setProfile(data)
      return data
    } catch(e) { return null }
  }, [])

  const showToast = (msg, type='success') => { setToast({msg,type}); setTimeout(()=>setToast(null), type==='error' ? 10000 : 3000) }

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: itemsData }, { data: settingsData }] = await Promise.all([
        supabase.from('items').select('*').order('versanddatum',{ascending:false,nullsFirst:false}).order('id',{ascending:false}).limit(2000),
        supabase.from('settings').select('*').eq('id',1),
      ])
      setItems(itemsData || [])
      if (settingsData?.length) setSettings(settingsData[0])
    } catch(e) { console.error('loadData error:', e) }
    setLoading(false)
  },[])

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const u = session?.user ?? null
      setUser(u)
      try { if (u) await Promise.all([loadProfile(u.id), loadData()]) } catch(e) {}
      setAuthLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) Promise.all([loadProfile(u.id), loadData()])
      else { setProfile(null); setItems([]) }
    })
    return () => subscription.unsubscribe()
  }, [loadProfile, loadData])

  // Upload handler
  const handleUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadResult(null)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type:'array', cellDates:true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const raw = XLSX.utils.sheet_to_json(ws, { defval:'', raw: false })

      if (!raw.length) { showToast('Schritt 1 fehlgeschlagen: Datei ist leer oder kein gültiges XLSX/CSV.','error'); setUploading(false); return }

      showToast(`Schritt 1 OK: ${raw.length} Zeilen gelesen. KI erkennt Spalten...`)

      // Spaltennamen + Beispielzeilen an Claude schicken (nicht alle Daten)
      const headers = Object.keys(raw[0])
      const sampleRows = raw.slice(0, 5)

      let response, result
      try {
        response = await fetch('/api/parse-excel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headers, sampleRows }),
        })
        result = await response.json()
      } catch(fetchErr) {
        showToast('Schritt 2 fehlgeschlagen: Netzwerkfehler – ' + fetchErr.message, 'error')
        setUploading(false); return
      }

      if (!response.ok || result.error) {
        showToast('Schritt 2 fehlgeschlagen: ' + (result.error || 'HTTP ' + response.status), 'error')
        setUploading(false); return
      }

      const m = result.mapping
      if (!m?.bestellnummer || !m?.asin) {
        showToast('Spalten konnten nicht erkannt werden. Bitte Format prüfen.', 'error')
        setUploading(false); return
      }

      // Alle Zeilen lokal mit dem erkannten Mapping parsen
      const upserts = raw.map(row => {
        const bestellnummer = String(row[m.bestellnummer] || '').trim()
        const asin = String(row[m.asin] || '').trim()
        if (!bestellnummer || !asin) return null
        const etvRaw = m.etv ? String(row[m.etv] || '0').replace(',', '.') : '0'
        const storno_datum = m.storno_datum ? parseITIMDate(row[m.storno_datum]) : null
        return {
          bestellnummer, asin,
          produkt: String(m.produkt ? (row[m.produkt] || 'Unbekannt') : 'Unbekannt').trim(),
          order_type: String(m.order_type ? (row[m.order_type] || 'ORDER') : 'ORDER').trim(),
          bestelldatum: m.bestelldatum ? parseITIMDate(row[m.bestelldatum]) : null,
          versanddatum: m.versanddatum ? parseITIMDate(row[m.versanddatum]) : null,
          storno_datum: storno_datum || null,
          etv: parseFloat(etvRaw) || 0,
          abschlag_verwendet: settings.wertminderung,
          status: storno_datum ? 'storniert' : 'aktiv',
        }
      }).filter(Boolean)

      // Duplikate entfernen (gleiche bestellnummer+asin) — letzter Eintrag gewinnt
      const seen = new Map()
      upserts.forEach(u => seen.set(u.bestellnummer + '|' + u.asin, u))
      const deduped = Array.from(seen.values())

      if (!deduped.length) { showToast('Keine gültigen Artikel gefunden.','error'); setUploading(false); return }
      const dupCount = upserts.length - deduped.length
      if (dupCount > 0) showToast(`${dupCount} doppelte Einträge ignoriert.`)

      // upserts durch deduplizierte Liste ersetzen
      upserts.length = 0
      deduped.forEach(u => upserts.push(u))

      // Token-Check: jedes Item kostet 1 Token (Admin hat unbegrenzt)
      if (profile?.role !== 'admin') {
        const available = profile?.tokens || 0
        if (available < upserts.length) {
          showToast(`Nicht genug Token! Du hast ${available} Token, brauchst aber ${upserts.length}.`, 'error')
          setUploading(false); return
        }
      }

      // user_id zu jedem Artikel hinzufügen
      const uid = user?.id
      if (!uid) { showToast('Fehler: Nicht eingeloggt', 'error'); setUploading(false); return }

      const upsertsWithUser = upserts.map(u => ({ ...u, user_id: uid }))
      const { error: upsertError } = await supabase.from('items').upsert(upsertsWithUser, { onConflict:'bestellnummer,asin', ignoreDuplicates:false })
      if (upsertError) { showToast('DB-Fehler beim Speichern: ' + (upsertError.message || upsertError.code), 'error'); setUploading(false); return }

      // Token abziehen
      if (profile?.role !== 'admin') {
        await supabase.rpc('spend_tokens', { amount: upserts.length })
        const { data: updatedProfile } = await supabase.from('profiles').select('*').eq('id', uid).single()
        if (updatedProfile) setProfile(updatedProfile)
      }

      const { error: importError } = await supabase.from('imports').insert({ dateiname:file.name, anzahl_artikel:upserts.length, neue_artikel:upserts.length, aktualisierte_artikel: 0, user_id: uid })
      if (importError) console.error('Import log error:', importError)

      setUploadResult({ total: upserts.length })
      showToast(`${upserts.length} Artikel importiert!`)
      loadData()
    } catch(err) { showToast('Upload fehlgeschlagen: '+(err.message || JSON.stringify(err)),'error'); console.error('Upload error:', err) }
    setUploading(false)
    e.target.value = ''
  }

  const saveItem = async (item) => {
    try {
      const { error } = await supabase.from('items').update({
        verkaufspreis: item.verkaufspreis,
        gebuehren_versand: item.gebuehren_versand,
        verkauft_am: item.verkauft_am || null,
        notizen: item.notizen,
        status: item.status,
        abschlag_optional: item.abschlag_optional,
        abschlag_verwendet: item.abschlag_verwendet,
        updated_at: new Date().toISOString(),
      }).eq('id', item.id)
      if (error) throw error
      showToast('Gespeichert!')
      setEditItem(null)
      loadData()
    } catch(e) { showToast('Fehler: '+e.message,'error') }
  }

  const saveSettings = async () => {
    try {
      const { error } = await supabase.from('settings').update({
        steuersatz: settings.steuersatz,
        wertminderung: settings.wertminderung,
        gebuehrenrate: settings.gebuehrenrate,
      }).eq('id',1)
      if (error) throw error
      showToast('Einstellungen gespeichert!')
      setSettingsOpen(false)
    } catch(e) { showToast('Fehler: '+e.message,'error') }
  }

  // Quick save for swipe review
  const quickSave = async (item, status, abschlag, notizen) => {
    try {
      const { error } = await supabase.from('items').update({
        status,
        abschlag_verwendet: abschlag,
        bewertet: true,
        updated_at: new Date().toISOString(),
        ...(notizen !== undefined ? { notizen } : {}),
      }).eq('id', item.id)
      if (error) throw error
      const newWertansatz = (parseFloat(item.etv)||0) * (1 - abschlag)
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status, abschlag_verwendet: abschlag, bewertet: true, wertansatz: newWertansatz, ...(notizen !== undefined ? { notizen } : {}) } : i))
    } catch(e) { showToast('Fehler: '+e.message,'error') }
  }

  // Computed data
  const monthlyData = useMemo(() => {
    const data = MONTHS_FULL.map((name,i) => ({ name, short: MONTHS[i], month:i+1, items:[], etv:0, wertansatz:0, bewertetCount:0 }))
    items.forEach(item => {
      const m = item.monat
      if (m>=1 && m<=12) {
        data[m-1].items.push(item)
        data[m-1].etv += parseFloat(item.etv)||0
        data[m-1].wertansatz += parseFloat(item.wertansatz)||0
        if (item.bewertet) data[m-1].bewertetCount++
      }
    })
    return data
  },[items])

  const totals = useMemo(() => ({
    etv: items.reduce((s,i)=>s+(parseFloat(i.etv)||0),0),
    wertansatz: items.reduce((s,i)=>s+(parseFloat(i.wertansatz)||0),0),
    steuer: items.reduce((s,i)=>s+((parseFloat(i.wertansatz)||0)*settings.steuersatz),0),
    verkauf: items.reduce((s,i)=>s+(parseFloat(i.verkaufspreis)||0),0),
    count: items.length,
    aktiv: items.filter(i=>i.status==='aktiv').length,
    defekt: items.filter(i=>i.status==='defekt').length,
    verkauft: items.filter(i=>i.status==='verkauft').length,
    storniert: items.filter(i=>i.status==='storniert').length,
    verschenkt: items.filter(i=>i.status==='verschenkt').length,
    sellable: items.filter(isSellable).length,
    bewertet: items.filter(i=>i.bewertet).length,
  }),[items,settings.steuersatz])

  const filteredItems = useMemo(() => {
    let list = items
    if (selectedMonth!==null) list = list.filter(i=>i.monat===selectedMonth)
    if (statusFilter!=='alle') list = list.filter(i=>i.status===statusFilter)
    if (sellableFilter) list = list.filter(isSellable)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(i=>i.produkt?.toLowerCase().includes(q)||i.asin?.toLowerCase().includes(q)||i.bestellnummer?.toLowerCase().includes(q)||i.notizen?.toLowerCase().includes(q))
    }
    return list
  },[items,selectedMonth,statusFilter,sellableFilter,search])

  // Unreviewed items for swipe mode — persistent via DB field `bewertet`
  const unreviewedItems = useMemo(() =>
    items.filter(i => i.status === 'aktiv' && !i.bewertet)
  ,[items])

  if (authLoading) return (
    <div className="loading-screen">
      <div className="loading-vine">
        <div className="loading-logo">V</div>
        <div className="loading-spinner" />
      </div>
      <p className="loading-text">Vine Tracker lädt...</p>
    </div>
  )

  if (!user) return <AuthScreen onAuth={setUser} />

  if (loading) return (
    <div className="loading-screen">
      <div className="loading-vine">
        <div className="loading-logo">V</div>
        <div className="loading-spinner" />
      </div>
      <p className="loading-text">Daten werden geladen...</p>
    </div>
  )

  return (
    <div className="app">
      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}

      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="logo">V</div>
          <div>
            <h1 className="title">Vine Tracker</h1>
            <p className="subtitle">{totals.count} Artikel</p>
          </div>
        </div>
        <div className="header-right">
          {totals.sellable > 0 && (
            <button className="sellable-badge" onClick={()=>{setSellableFilter(true);setView('items')}}>
              <span className="sellable-dot" />
              {totals.sellable} verkaufbar
            </button>
          )}
          <button className="header-btn" onClick={()=>setProfileOpen(true)} aria-label="Profil">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          </button>
          <button className="header-btn" onClick={()=>setSettingsOpen(true)} aria-label="Einstellungen">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="main">
        {view==='dashboard' && (
          <Dashboard
            totals={totals}
            monthlyData={monthlyData}
            settings={settings}
            onMonthClick={m=>{setSelectedMonth(m);setView('items')}}
            onSellableClick={()=>{setSellableFilter(true);setView('items')}}
            onStatusClick={(key,month)=>{setStatusFilter(key);if(month){setSelectedMonth(month)}else{setSelectedMonth(null)};setView('items')}}
            onReviewClick={()=>setView('review')}
          />
        )}
        {view==='items' && (
          <ItemList
            items={filteredItems}
            search={search} setSearch={setSearch}
            statusFilter={statusFilter} setStatusFilter={setStatusFilter}
            selectedMonth={selectedMonth} setSelectedMonth={setSelectedMonth}
            sellableFilter={sellableFilter} setSellableFilter={setSellableFilter}
            onEdit={i=>setEditItem({...i})}
          />
        )}
        {view==='review' && (
          <SwipeReview
            items={unreviewedItems}
            index={reviewIndex}
            setIndex={setReviewIndex}
            settings={settings}
            onSave={quickSave}
            onEditFull={i=>{setEditItem({...i})}}
            showToast={showToast}
          />
        )}
        {view==='upload' && (
          <UploadView
            onUpload={handleUpload}
            uploading={uploading}
            result={uploadResult}
            unreviewedCount={unreviewedItems.length}
            onStartReview={()=>{setReviewIndex(0);setView('review')}}
            profile={profile}
          />
        )}
        {view==='admin' && profile?.role==='admin' && (
          <AdminPanel showToast={showToast} />
        )}
      </main>

      {/* Bottom Navigation */}
      <nav className="bottom-nav">
        {[
          {id:'dashboard',label:'Übersicht',icon:<IconDashboard/>},
          {id:'items',label:'Artikel',icon:<IconList/>},
          {id:'review',label:'Bewerten',icon:<IconSwipe/>, badge: unreviewedItems.length||null},
          {id:'upload',label:'Import',icon:<IconUpload/>},
          ...(profile?.role==='admin' ? [{id:'admin',label:'Admin',icon:<IconAdmin/>}] : []),
        ].map(tab=>(
          <button key={tab.id} className={`nav-tab ${view===tab.id?'active':''}`}
            onClick={()=>{setView(tab.id);if(tab.id!=='items'){setSelectedMonth(null);setSellableFilter(false)}}}>
            <div className="nav-tab-icon">
              {tab.icon}
              {tab.badge && <span className="nav-badge">{tab.badge > 99 ? '99+' : tab.badge}</span>}
            </div>
            <span className="nav-tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Modals */}
      {editItem && <EditModal item={editItem} settings={settings} onSave={saveItem} onClose={()=>setEditItem(null)} />}
      {settingsOpen && <SettingsModal settings={settings} setSettings={setSettings} onSave={saveSettings} onClose={()=>setSettingsOpen(false)} />}
      {profileOpen && <ProfileModal user={user} onClose={()=>setProfileOpen(false)} showToast={showToast} />}
    </div>
  )
}

// ─── Dashboard ───
function Dashboard({totals,monthlyData,settings,onMonthClick,onSellableClick,onStatusClick,onReviewClick}) {
  const [selectedMonth, setSelectedMonth] = useState(null) // index 0-11
  const maxETV = Math.max(...monthlyData.map(m=>m.etv),1)
  const activeMonths = monthlyData.filter(m=>m.items.length>0)

  const sel = selectedMonth !== null ? monthlyData[selectedMonth] : null
  const kpi = sel ? {
    etv: sel.etv,
    wertansatz: sel.wertansatz,
    steuer: sel.wertansatz * settings.steuersatz,
    verkauf: sel.items.reduce((s,i)=>s+(parseFloat(i.verkaufspreis)||0),0),
    label: sel.name,
    statusCounts: Object.fromEntries(
      Object.keys(STATUS_LABELS).map(k=>[k, sel.items.filter(i=>i.status===k).length])
    ),
  } : {
    etv: totals.etv,
    wertansatz: totals.wertansatz,
    steuer: totals.steuer,
    verkauf: totals.verkauf,
    label: null,
    statusCounts: null,
  }

  return (
    <div className="view-stack">
      {/* Bewertungs-Fortschritt */}
      {totals.count > 0 && (
        <button className="review-progress-banner" onClick={onReviewClick}>
          <div className="rpb-left">
            <span className="rpb-title">Bewertungsfortschritt</span>
            <span className="rpb-sub">{totals.bewertet} von {totals.count} Artikeln bewertet</span>
          </div>
          <div className="rpb-right">
            <div className="rpb-bar-track">
              <div className="rpb-bar-fill" style={{width:`${(totals.bewertet/totals.count)*100}%`}}/>
            </div>
            <span className="rpb-pct">{Math.round((totals.bewertet/totals.count)*100)}%</span>
          </div>
        </button>
      )}

      {/* Sellable Alert */}
      {totals.sellable > 0 && (
        <button className="sellable-alert" onClick={onSellableClick}>
          <div className="sellable-alert-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M8 12l3 3 5-5"/></svg>
          </div>
          <div className="sellable-alert-text">
            <strong>{totals.sellable} Artikel verkaufbar</strong>
            <span>6-Monats-Frist abgelaufen</span>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      )}

      {/* KPI Cards */}
      <div className="kpi-section">
        {kpi.label && (
          <div className="kpi-month-header">
            <span className="kpi-month-name">{kpi.label}</span>
            <div className="kpi-month-actions">
              <button className="kpi-month-items" onClick={()=>onMonthClick(selectedMonth+1)}>
                Artikel ansehen
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
              </button>
              <button className="kpi-month-reset" onClick={()=>setSelectedMonth(null)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
        )}
        <div className="kpi-grid">
          <div className="kpi-card">
            <span className="kpi-label">Summe ETV</span>
            <span className="kpi-value kpi-amber">{fmt(kpi.etv)}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Wertansatz</span>
            <span className="kpi-value kpi-purple">{fmt(kpi.wertansatz)}</span>
          </div>
          <div className="kpi-card kpi-highlight">
            <span className="kpi-label">Steuerlast</span>
            <span className="kpi-value kpi-red">{fmt(kpi.steuer)}</span>
            <span className="kpi-sub">{(settings.steuersatz*100).toFixed(0)}% Steuersatz</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Verkäufe</span>
            <span className="kpi-value kpi-green">{fmt(kpi.verkauf)}</span>
          </div>
        </div>
      </div>

      {/* Status Overview */}
      <div className="card">
        <h3 className="card-title">Status{kpi.label ? ` · ${kpi.label}` : ''}</h3>
        <div className="status-pills">
          {Object.entries(STATUS_LABELS).map(([key,label])=>{
            const count = kpi.statusCounts ? (kpi.statusCounts[key] || 0) : (totals[key] || 0)
            return (
              <button key={key} className="status-pill" style={{'--status-color':STATUS_COLORS[key]}}
                onClick={()=>count>0&&onStatusClick(key, selectedMonth!==null ? selectedMonth+1 : null)} disabled={count===0}>
                <span className="status-pill-icon">{STATUS_ICONS[key]}</span>
                <span className="status-pill-count">{count}</span>
                <span className="status-pill-label">{label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Monthly Chart */}
      <div className="card">
        <h3 className="card-title">Monatsübersicht</h3>
        <div className="month-chart">
          {monthlyData.map((m,i)=>(
            <button key={i} className={`month-bar-item ${m.items.length?'has-data':''} ${selectedMonth===i?'selected':''}`}
              onClick={()=>{
                if (!m.items.length) return
                setSelectedMonth(prev => prev===i ? null : i)
              }}>
              <div className="month-bar-track">
                <div className="month-bar-fill" style={{height:`${(m.etv/maxETV)*100}%`}} />
              </div>
              <span className="month-bar-label">{m.short}</span>
              {m.items.length > 0 && <span className="month-bar-count">{m.items.length}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Monatliche Steuerlast */}
      {activeMonths.length > 0 && (
        <div className="card">
          <h3 className="card-title">Monatliche Steuerlast</h3>
          <p className="card-desc" style={{fontSize:12,color:'#64748b',marginBottom:12}}>
            Erwartete Steuer nach Abschreibung · {(settings.steuersatz*100).toFixed(0)}% Steuersatz
          </p>
          <div className="tax-table">
            <div className="tax-table-head">
              <span>Monat</span>
              <span>Bewertet</span>
              <span>Wertansatz</span>
              <span>Steuer</span>
            </div>
            {activeMonths.map((m,i)=>{
              const steuer = m.wertansatz * settings.steuersatz
              return (
                <button key={i} className="tax-table-row" onClick={()=>onMonthClick(m.month)}>
                  <span className="tax-month">{m.short}</span>
                  <span className="tax-bewertet">{m.bewertetCount}/{m.items.length}</span>
                  <span className="tax-wert">{fmt(m.wertansatz)}</span>
                  <span className="tax-steuer">{fmt(steuer)}</span>
                </button>
              )
            })}
            <div className="tax-table-total">
              <span>Gesamt</span>
              <span>{totals.bewertet}/{totals.count}</span>
              <span>{fmt(totals.wertansatz)}</span>
              <span>{fmt(totals.steuer)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Parameters */}
      <div className="card">
        <h3 className="card-title">Parameter</h3>
        <div className="param-row">
          <div className="param-item">
            <span className="param-val" style={{color:'#f59e0b'}}>{(settings.steuersatz*100).toFixed(0)}%</span>
            <span className="param-label">Steuersatz</span>
          </div>
          <div className="param-divider" />
          <div className="param-item">
            <span className="param-val" style={{color:'#8b5cf6'}}>{(settings.wertminderung*100).toFixed(0)}%</span>
            <span className="param-label">Wertminderung</span>
          </div>
          <div className="param-divider" />
          <div className="param-item">
            <span className="param-val" style={{color:'#3b82f6'}}>{(settings.gebuehrenrate*100).toFixed(0)}%</span>
            <span className="param-label">Gebührenrate</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Item List ───
function ItemList({items,search,setSearch,statusFilter,setStatusFilter,selectedMonth,setSelectedMonth,sellableFilter,setSellableFilter,onEdit}) {
  return (
    <div className="view-stack">
      {/* Search */}
      <div className="search-bar">
        <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input className="search-input" placeholder="Suchen..." value={search} onChange={e=>setSearch(e.target.value)} />
        {search && <button className="search-clear" onClick={()=>setSearch('')}>✕</button>}
      </div>

      {/* Filters */}
      <div className="filter-row">
        {selectedMonth && (
          <button className="filter-chip active-month" onClick={()=>setSelectedMonth(null)}>
            ✕ {MONTHS_FULL[selectedMonth-1]}
          </button>
        )}
        {sellableFilter && (
          <button className="filter-chip active-sellable" onClick={()=>setSellableFilter(false)}>
            ✕ Verkaufbar
          </button>
        )}
        <div className="filter-scroll">
          {['alle','aktiv','defekt','verkauft','storniert','verschenkt'].map(s=>(
            <button key={s}
              className={`filter-chip ${statusFilter===s?'active':''}`}
              style={statusFilter===s?{'--chip-color':STATUS_COLORS[s]||'#64748b'}:{}}
              onClick={()=>setStatusFilter(s)}>
              {s==='alle'?'Alle':STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {/* Count */}
      <p className="list-count">{items.length} Artikel</p>

      {/* Items */}
      <div className="item-list">
        {items.map(item => {
          const sellable = isSellable(item)
          const days = daysUntilSellable(item)
          return (
            <button key={item.id} className={`item-card ${sellable ? 'item-sellable' : ''}`} onClick={()=>onEdit(item)}>
              <div className="item-row">
                <div className="item-info">
                  <p className="item-name">{item.produkt}</p>
                  <p className="item-meta">
                    {item.asin}
                    {item.versanddatum && <> · {fmtDateShort(item.versanddatum)}</>}
                  </p>
                </div>
                <div className="item-values">
                  <p className="item-etv">{fmt(item.etv)}</p>
                  <p className="item-wa">{fmt(item.wertansatz)}</p>
                </div>
              </div>
              <div className="item-tags">
                <span className="tag" style={{'--tag-color':STATUS_COLORS[item.status]}}>
                  {STATUS_ICONS[item.status]} {STATUS_LABELS[item.status]||item.status}
                </span>
                {sellable && (
                  <span className="tag tag-sellable">Verkaufbar</span>
                )}
                {!sellable && days > 0 && days <= 30 && item.status === 'aktiv' && (
                  <span className="tag tag-soon">Noch {days} Tage</span>
                )}
                {parseFloat(item.abschlag_verwendet)===1 && (
                  <span className="tag tag-warn">100%</span>
                )}
                {item.notizen && <span className="item-note-icon" title={item.notizen}>📝</span>}
              </div>
            </button>
          )
        })}
      </div>

      {!items.length && (
        <div className="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="1.5"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
          <p>Keine Artikel gefunden</p>
        </div>
      )}
    </div>
  )
}

// ─── Swipe Review ───
function SwipeReview({items,index,setIndex,settings,onSave,onEditFull,showToast}) {
  const [currentStatus, setCurrentStatus] = useState('aktiv')
  const [currentAbschlag, setCurrentAbschlag] = useState(0.5)
  const [currentNotizen, setCurrentNotizen] = useState('')
  const [saving, setSaving] = useState(false)
  const [direction, setDirection] = useState(null)
  const cardRef = useRef(null)
  const touchStartX = useRef(0)
  const touchCurrentX = useRef(0)
  const notizenRef = useRef(null)

  const item = items[index]
  const showNotizenField = currentAbschlag >= 0.7

  useEffect(() => {
    if (item) {
      setCurrentStatus(item.status || 'aktiv')
      setCurrentAbschlag(parseFloat(item.abschlag_verwendet) || settings.wertminderung)
      setCurrentNotizen(item.notizen || '')
    }
  }, [item, settings.wertminderung])

  useEffect(() => {
    if (showNotizenField && notizenRef.current) {
      notizenRef.current.focus()
    }
  }, [showNotizenField])

  const handleNext = async () => {
    if (!item || saving) return
    if (showNotizenField && !currentNotizen.trim()) {
      showToast('Bitte Begründung für 70%+ Abschlag eintragen (Finanzamt)', 'error')
      notizenRef.current?.focus()
      return
    }
    setSaving(true)
    await onSave(item, currentStatus, currentAbschlag, showNotizenField ? currentNotizen : item.notizen)
    showToast(`${currentStatus === 'defekt' ? 'Defekt' : 'Gespeichert'} – ${ABSCHLAG_OPTIONS.find(o=>o.value===currentAbschlag)?.label || currentAbschlag*100+'%'} Abschlag`)
    setDirection('left')
    setTimeout(() => {
      setDirection(null)
      setIndex(i => Math.min(i + 1, items.length))
      setSaving(false)
    }, 250)
  }

  const handleSkip = () => {
    setDirection('right')
    setTimeout(() => {
      setDirection(null)
      setIndex(i => Math.min(i + 1, items.length))
    }, 250)
  }

  // Touch handlers for swipe
  const onTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX
    touchCurrentX.current = e.touches[0].clientX
  }
  const onTouchMove = (e) => {
    touchCurrentX.current = e.touches[0].clientX
    const diff = touchCurrentX.current - touchStartX.current
    if (cardRef.current) {
      cardRef.current.style.transform = `translateX(${diff * 0.4}px) rotate(${diff * 0.02}deg)`
      cardRef.current.style.transition = 'none'
    }
  }
  const onTouchEnd = () => {
    const diff = touchCurrentX.current - touchStartX.current
    if (cardRef.current) {
      cardRef.current.style.transition = 'transform 0.3s ease'
      cardRef.current.style.transform = ''
    }
    if (diff < -80) handleNext()
    else if (diff > 80) handleSkip()
  }

  if (!items.length) return (
    <div className="review-empty">
      <div className="review-empty-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
      </div>
      <h2>Alles bewertet!</h2>
      <p>Keine unbewerteten Artikel vorhanden.</p>
    </div>
  )

  if (index >= items.length) return (
    <div className="review-empty">
      <div className="review-empty-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
      </div>
      <h2>Fertig!</h2>
      <p>{items.length} Artikel bewertet.</p>
      <button className="btn-primary" onClick={()=>setIndex(0)} style={{marginTop:16}}>Nochmal durchgehen</button>
    </div>
  )

  const wertansatz = (parseFloat(item.etv)||0) * (1 - currentAbschlag)

  return (
    <div className="review-view">
      {/* Progress */}
      <div className="review-progress">
        <div className="review-progress-bar">
          <div className="review-progress-fill" style={{width:`${((index+1)/items.length)*100}%`}} />
        </div>
        <span className="review-progress-text">{index+1} / {items.length}</span>
      </div>

      {/* Card */}
      <div
        ref={cardRef}
        className={`review-card ${direction ? 'review-card-'+direction : ''}`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="review-card-header">
          <span className="review-etv">{fmt(item.etv)}</span>
          {isSellable(item) && <span className="tag tag-sellable">Verkaufbar</span>}
        </div>

        <h3 className="review-product">{item.produkt}</h3>
        <p className="review-meta">
          {item.asin} · {fmtDate(item.versanddatum)}
        </p>

        {/* Status Selection */}
        <div className="review-section">
          <label className="review-label">Status</label>
          <div className="review-status-grid">
            {[
              {key:'aktiv',label:'Benutzbar',icon:'✓',color:'#22c55e'},
              {key:'defekt',label:'Defekt',icon:'✕',color:'#ef4444'},
              {key:'verschenkt',label:'Verschenkt',icon:'♡',color:'#a855f7'},
              {key:'storniert',label:'Storniert',icon:'⊘',color:'#94a3b8'},
            ].map(s=>(
              <button key={s.key}
                className={`review-status-btn ${currentStatus===s.key?'active':''}`}
                style={{'--btn-color':s.color}}
                onClick={()=>setCurrentStatus(s.key)}>
                <span className="review-status-icon">{s.icon}</span>
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Abschlag Selection */}
        <div className="review-section">
          <label className="review-label">
            Abschreibung
            <span className="review-label-value">{fmt(wertansatz)} Wertansatz</span>
          </label>
          <div className="abschlag-options">
            {ABSCHLAG_OPTIONS.map(opt=>(
              <button key={opt.value}
                className={`abschlag-btn ${currentAbschlag===opt.value?'active':''}`}
                onClick={()=>setCurrentAbschlag(opt.value)}>
                <span className="abschlag-pct">{opt.label}</span>
                <span className="abschlag-desc">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Notizfeld bei 70%+ Abschlag */}
        {showNotizenField && (
          <div className="review-section review-notiz-section">
            <label className="review-label">
              📝 Begründung für Finanzamt
              <span className="review-notiz-hint">Pflichtfeld bei 70%+</span>
            </label>
            <textarea
              ref={notizenRef}
              className="review-notiz-input"
              value={currentNotizen}
              onChange={e=>setCurrentNotizen(e.target.value)}
              placeholder="z.B. Artikel hat Gebrauchsspuren, Qualitätsmängel, nicht dem Neuwertzustand entsprechend..."
              rows={3}
            />
          </div>
        )}

        {/* Expand button */}
        <button className="review-expand" onClick={()=>onEditFull(item)}>
          Alle Details bearbeiten
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>

      {/* Action Buttons */}
      <div className="review-actions">
        <button className="review-action-skip" onClick={handleSkip}>
          Überspringen
        </button>
        <button className="review-action-save" onClick={handleNext} disabled={saving}>
          {saving ? 'Speichere...' : 'Speichern & Weiter'}
        </button>
      </div>

      <p className="review-hint">Wische nach links zum Speichern, nach rechts zum Überspringen</p>
    </div>
  )
}

// ─── Upload View ───
function UploadView({onUpload,uploading,result,unreviewedCount,onStartReview,profile}) {
  return (
    <div className="view-stack">
      {profile?.role !== 'admin' && (
        <div className="free-limit-banner">
          <div>
            <strong>Token-Guthaben</strong>
            <span>Jeder importierte Artikel kostet 1 Token</span>
          </div>
          <span className="free-limit-badge" style={{background: (profile?.tokens||0) > 0 ? '#22c55e' : '#ef4444'}}>
            {profile?.tokens || 0} Token
          </span>
        </div>
      )}
      <div className="card">
        <h3 className="card-title">Vine Report importieren</h3>
        <p className="card-desc">
          Lade deine Amazon Vine ITIM-Report Datei hoch. Bestehende Artikel werden aktualisiert, neue hinzugefügt.
        </p>
        <label className="upload-zone">
          <input type="file" accept=".csv,.xlsx,.xls" onChange={onUpload} style={{display:'none'}} disabled={uploading} />
          {uploading ? (
            <div className="upload-loading">
              <div className="loading-spinner" />
              <p>Importiere...</p>
            </div>
          ) : (
            <div className="upload-content">
              <div className="upload-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              </div>
              <p className="upload-title">Datei auswählen</p>
              <p className="upload-sub">XLSX oder CSV (ITIM-Report)</p>
            </div>
          )}
        </label>
        {result && (
          <div className="upload-success">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
            {result.total} Artikel importiert
          </div>
        )}
      </div>

      {/* Review CTA */}
      {unreviewedCount > 0 && (
        <button className="review-cta" onClick={onStartReview}>
          <div className="review-cta-content">
            <div className="review-cta-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            </div>
            <div>
              <strong>{unreviewedCount} Artikel bewerten</strong>
              <span>Jetzt im Swipe-Modus durchgehen</span>
            </div>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      )}

      {/* Info */}
      <div className="card">
        <h3 className="card-title">Spalten-Erkennung</h3>
        <div className="info-list">
          <div className="info-row"><span className="info-from">Order Number</span><span className="info-arrow">→</span><span className="info-to">Bestellnummer</span></div>
          <div className="info-row"><span className="info-from">ASIN</span><span className="info-arrow">→</span><span className="info-to">Produkt-ID</span></div>
          <div className="info-row"><span className="info-from">Product Name</span><span className="info-arrow">→</span><span className="info-to">Produktname</span></div>
          <div className="info-row"><span className="info-from">Consideration Amount</span><span className="info-arrow">→</span><span className="info-to">ETV</span></div>
          <div className="info-row"><span className="info-from">Shipped Date</span><span className="info-arrow">→</span><span className="info-to">Versanddatum</span></div>
        </div>
        <p className="card-note">Duplikate werden automatisch erkannt und aktualisiert.</p>
      </div>
    </div>
  )
}

// ─── Edit Modal ───
function EditModal({item,settings,onSave,onClose}) {
  const [form,setForm] = useState({...item})
  const set = (k,v) => setForm(f=>({...f,[k]:v}))

  const wertansatz = (parseFloat(form.etv)||0)*(1-(parseFloat(form.abschlag_verwendet)||0))
  const steuer = wertansatz*settings.steuersatz
  const gewinnVor = (parseFloat(form.verkaufspreis)||0)-(parseFloat(form.gebuehren_versand)||0)-wertansatz
  const gewinnNach = gewinnVor-steuer
  const sellable = isSellable(form)
  const days = daysUntilSellable(form)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Artikel bearbeiten</h2>
          <button className="modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <p className="modal-product">{form.produkt}</p>
        <p className="modal-meta">{form.asin} · Nr. {form.bestellnummer}</p>

        {/* 6-Month Indicator */}
        {sellable ? (
          <div className="modal-sellable-banner">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
            Artikel darf verkauft werden (6 Monate erreicht)
          </div>
        ) : days !== null && days > 0 && form.status === 'aktiv' ? (
          <div className="modal-wait-banner">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            Noch {days} Tage bis zum Verkauf (ab {fmtDate((() => { const d = new Date(form.versanddatum); d.setMonth(d.getMonth()+6); return d })())})
          </div>
        ) : null}

        <div className="modal-values">
          <div className="modal-val-box">
            <span className="modal-val-label">ETV</span>
            <span className="modal-val-num amber">{fmt(form.etv)}</span>
          </div>
          <div className="modal-val-box">
            <span className="modal-val-label">Wertansatz</span>
            <span className="modal-val-num purple">{fmt(wertansatz)}</span>
          </div>
        </div>

        {/* Status */}
        <label className="field-label">Status</label>
        <div className="status-buttons">
          {Object.entries(STATUS_LABELS).map(([key,label])=>(
            <button key={key}
              className={`status-btn ${form.status===key?'active':''}`}
              style={{'--btn-color':STATUS_COLORS[key]}}
              onClick={()=>set('status',key)}>
              {STATUS_ICONS[key]} {label}
            </button>
          ))}
        </div>

        {/* Abschlag */}
        <label className="field-label">Abschreibung</label>
        <div className="abschlag-grid">
          {ABSCHLAG_OPTIONS.map(opt=>(
            <button key={opt.value}
              className={`abschlag-btn ${parseFloat(form.abschlag_verwendet)===opt.value?'active':''}`}
              onClick={()=>set('abschlag_verwendet',opt.value)}>
              {opt.label}
            </button>
          ))}
        </div>

        {/* Sale Details (collapsible) */}
        <details className="sale-details">
          <summary className="sale-summary">Verkaufsdetails</summary>
          <div className="sale-content">
            <div className="field-row">
              <div className="field-col">
                <label className="field-label">Verkaufspreis (€)</label>
                <input className="field-input" type="number" step="0.01" placeholder="0.00"
                  value={form.verkaufspreis||''} onChange={e=>set('verkaufspreis',e.target.value?parseFloat(e.target.value):null)} />
              </div>
              <div className="field-col">
                <label className="field-label">Gebühren/Versand (€)</label>
                <input className="field-input" type="number" step="0.01" placeholder="0.00"
                  value={form.gebuehren_versand||''} onChange={e=>set('gebuehren_versand',e.target.value?parseFloat(e.target.value):null)} />
              </div>
            </div>
            <label className="field-label">Verkauft am</label>
            <input className="field-input" type="date" value={form.verkauft_am||''} onChange={e=>set('verkauft_am',e.target.value||null)} />

            {form.verkaufspreis>0 && (
              <div className="calc-box">
                <div className="calc-row"><span>Steuer</span><span className="calc-red">{fmt(steuer)}</span></div>
                <div className="calc-row"><span>Gewinn vor Steuer</span><span className={gewinnVor>=0?'calc-green':'calc-red'}>{fmt(gewinnVor)}</span></div>
                <div className="calc-row calc-total"><span>Gewinn nach Steuer</span><span className={gewinnNach>=0?'calc-green':'calc-red'}>{fmt(gewinnNach)}</span></div>
              </div>
            )}
          </div>
        </details>

        {/* Notes */}
        <label className="field-label">Notizen</label>
        <textarea className="field-input field-textarea" value={form.notizen||''} onChange={e=>set('notizen',e.target.value)} placeholder="z.B. Defekt, nicht lieferbar..." />

        <button className="btn-primary btn-full" onClick={()=>onSave(form)}>Speichern</button>
      </div>
    </div>
  )
}

// ─── Settings Modal ───
function SettingsModal({settings,setSettings,onSave,onClose}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Einstellungen</h2>
          <button className="modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <label className="field-label">Steuersatz (%)</label>
        <input className="field-input" type="number" step="0.01" min="0" max="1"
          value={settings.steuersatz}
          onChange={e=>setSettings(s=>({...s,steuersatz:parseFloat(e.target.value)||0}))} />

        <label className="field-label">Wertminderung / Abschlag (%)</label>
        <input className="field-input" type="number" step="0.01" min="0" max="1"
          value={settings.wertminderung}
          onChange={e=>setSettings(s=>({...s,wertminderung:parseFloat(e.target.value)||0}))} />

        <label className="field-label">Gebührenrate (%)</label>
        <input className="field-input" type="number" step="0.01" min="0" max="1"
          value={settings.gebuehrenrate}
          onChange={e=>setSettings(s=>({...s,gebuehrenrate:parseFloat(e.target.value)||0}))} />

        <p className="settings-hint">Werte als Dezimalzahl eingeben (z.B. 0.35 = 35%)</p>

        <button className="btn-primary btn-full" onClick={onSave}>Einstellungen speichern</button>
      </div>
    </div>
  )
}

// ─── Auth Screen ───
function AuthScreen({onAuth}) {
  const [tab, setTab] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true); setError(null)
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    else onAuth(data.user)
    setLoading(false)
  }

  const handleRegister = async (e) => {
    e.preventDefault()
    setLoading(true); setError(null)
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { data: { full_name: name } }
    })
    if (error) setError(error.message)
    else setSuccess('Bestätigungs-E-Mail wurde gesendet! Bitte bestätige deine E-Mail-Adresse.')
    setLoading(false)
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">V</div>
        <h1 className="auth-title">Vine Tracker</h1>
        <div className="auth-tabs">
          <button className={`auth-tab ${tab==='login'?'active':''}`} onClick={()=>{setTab('login');setError(null);setSuccess(null)}}>Anmelden</button>
          <button className={`auth-tab ${tab==='register'?'active':''}`} onClick={()=>{setTab('register');setError(null);setSuccess(null)}}>Registrieren</button>
        </div>
        {success ? (
          <div className="auth-success">{success}</div>
        ) : (
          <form onSubmit={tab==='login'?handleLogin:handleRegister} className="auth-form">
            {tab==='register' && (
              <input className="field-input" type="text" placeholder="Dein Name" value={name}
                onChange={e=>setName(e.target.value)} required />
            )}
            <input className="field-input" type="email" placeholder="E-Mail" value={email}
              onChange={e=>setEmail(e.target.value)} required />
            <input className="field-input" type="password" placeholder="Passwort" value={password}
              onChange={e=>setPassword(e.target.value)} required minLength={6} />
            {error && <div className="auth-error">{error}</div>}
            <button className="btn-primary btn-full" type="submit" disabled={loading}>
              {loading ? 'Bitte warten...' : tab==='login' ? 'Anmelden' : 'Registrieren'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// ─── Profile Modal ───
function ProfileModal({user, onClose, showToast}) {
  const [name, setName] = useState(user.user_metadata?.full_name || '')
  const [email, setEmail] = useState(user.email || '')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [loading, setLoading] = useState(false)

  const save = async () => {
    setLoading(true)
    const updates = { data: { full_name: name } }
    if (email !== user.email) updates.email = email
    if (password) {
      if (password !== passwordConfirm) { showToast('Passwörter stimmen nicht überein', 'error'); setLoading(false); return }
      if (password.length < 6) { showToast('Passwort mindestens 6 Zeichen', 'error'); setLoading(false); return }
      updates.password = password
    }
    const { error } = await supabase.auth.updateUser(updates)
    if (error) showToast('Fehler: ' + error.message, 'error')
    else {
      showToast(email !== user.email ? 'Bestätigungs-E-Mail gesendet!' : 'Profil gespeichert!')
      if (!updates.email) onClose()
    }
    setLoading(false)
  }

  const logout = async () => {
    await supabase.auth.signOut()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Mein Profil</h2>
          <button className="modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <label className="field-label">Name</label>
        <input className="field-input" type="text" value={name} onChange={e=>setName(e.target.value)} placeholder="Dein Name" />
        <label className="field-label">E-Mail</label>
        <input className="field-input" type="email" value={email} onChange={e=>setEmail(e.target.value)} />
        <label className="field-label">Neues Passwort (leer lassen = unverändert)</label>
        <input className="field-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Neues Passwort" minLength={6} />
        <input className="field-input" type="password" value={passwordConfirm} onChange={e=>setPasswordConfirm(e.target.value)} placeholder="Passwort bestätigen" style={{marginTop:8}} />
        <button className="btn-primary btn-full" onClick={save} disabled={loading} style={{marginTop:16}}>
          {loading ? 'Speichern...' : 'Änderungen speichern'}
        </button>
        <button className="btn-logout" onClick={logout}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Abmelden
        </button>
      </div>
    </div>
  )
}

// ─── Admin Panel ───
function AdminPanel({showToast}) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [tokenInputs, setTokenInputs] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_get_users')
    if (error) showToast('Fehler: ' + error.message, 'error')
    else setUsers(data || [])
    setLoading(false)
  }, [showToast])

  useEffect(() => { load() }, [load])

  const toggleBlock = async (u) => {
    const { error } = await supabase.rpc('admin_update_user', {
      target_id: u.id,
      new_is_blocked: !u.is_blocked,
    })
    if (error) showToast('Fehler: ' + error.message, 'error')
    else { showToast(u.is_blocked ? 'Nutzer entsperrt' : 'Nutzer gesperrt'); load() }
  }

  const addTokens = async (u) => {
    const amount = parseInt(tokenInputs[u.id] || '0', 10)
    if (!amount || amount <= 0) { showToast('Bitte eine positive Zahl eingeben', 'error'); return }
    const { error } = await supabase.rpc('admin_update_user', {
      target_id: u.id,
      add_tokens: amount,
    })
    if (error) showToast('Fehler: ' + error.message, 'error')
    else {
      showToast(`${amount} Token für ${u.full_name || u.email} hinzugefügt`)
      setTokenInputs(prev => ({ ...prev, [u.id]: '' }))
      load()
    }
  }

  return (
    <div className="view-stack">
      <div className="card">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
          <h3 className="card-title" style={{marginBottom:0}}>Nutzerverwaltung</h3>
          <span style={{fontSize:12,color:'#64748b'}}>{users.length} Nutzer</span>
        </div>

        {loading ? (
          <div style={{textAlign:'center',padding:32,color:'#64748b'}}>Lädt...</div>
        ) : users.map(u => (
          <div key={u.id} className="admin-user-row">
            <div className="admin-user-info">
              <div className="admin-user-name">
                {u.full_name || '—'}
                {u.role === 'admin' && <span className="admin-badge">Admin</span>}
                {u.is_blocked && <span className="admin-badge blocked">Gesperrt</span>}
              </div>
              <div className="admin-user-email">{u.email}</div>
              <div className="admin-user-meta">
                {u.item_count} Artikel · {u.role === 'admin' ? '∞ Token' : `${u.tokens} Token`} · Seit {new Date(u.created_at).toLocaleDateString('de-DE')}
              </div>
            </div>
            <div className="admin-user-actions">
              {u.role !== 'admin' && (
                <div className="admin-token-row">
                  <input
                    className="admin-token-input"
                    type="number"
                    min="1"
                    placeholder="Anzahl"
                    value={tokenInputs[u.id] || ''}
                    onChange={e => setTokenInputs(prev => ({ ...prev, [u.id]: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && addTokens(u)}
                  />
                  <button className="admin-token-btn" onClick={() => addTokens(u)}>+ Token</button>
                </div>
              )}
              <button
                className={`admin-block-btn ${u.is_blocked ? 'blocked' : ''}`}
                onClick={() => toggleBlock(u)}
                disabled={u.role === 'admin'}
                title={u.role === 'admin' ? 'Admin kann nicht gesperrt werden' : ''}
              >
                {u.is_blocked ? 'Entsperren' : 'Sperren'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Icons ───
function IconDashboard() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
}
function IconList() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
}
function IconSwipe() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M12 8v4l2 2"/></svg>
}
function IconUpload() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
}
function IconAdmin() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
}
