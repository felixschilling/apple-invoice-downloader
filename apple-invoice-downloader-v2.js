const fs = require('fs');
const path = require('path');

// Konfiguration
const CONFIG = {
  sessionFile: 'apple-session.json',
  downloadDir: 'downloads',
  slowMo: 50,
  timeout: 30000
};

// Utility Funktionen
function sanitizeFilename(filename) {
  return filename
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/€/g, 'EUR')
    .substring(0, 150);
}

function parseGermanDate(dateStr) {
  const months = {
    'Jan.': '01', 'Feb.': '02', 'März': '03', 'Apr.': '04',
    'Mai': '05', 'Juni': '06', 'Juli': '07', 'Aug.': '08',
    'Sept.': '09', 'Okt.': '10', 'Nov.': '11', 'Dez.': '12'
  };
  
  const parts = dateStr.split(' ');
  if (parts.length >= 3) {
    const day = parts[0].replace('.', '').padStart(2, '0');
    const month = months[parts[1]] || '00';
    const year = parts[2];
    return `${year}-${month}-${day}`;
  }
  return dateStr.replace(/[.\s]/g, '-');
}

function isValidCalendarDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** CLI date: ISO (2025-01-01) or German (01.01.2025) → YYYY-MM-DD */
function parseCliDate(input, optionLabel) {
  const trimmed = String(input).trim();
  let y;
  let m;
  let d;

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    y = Number(isoMatch[1]);
    m = Number(isoMatch[2]);
    d = Number(isoMatch[3]);
  } else {
    const deMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!deMatch) {
      throw new Error(
        `Ungültiges Datum für ${optionLabel}: "${input}". ` +
        'Erwartet ISO (YYYY-MM-DD, z. B. 2025-01-01) oder deutsch (TT.MM.JJJJ, z. B. 01.01.2025).'
      );
    }
    d = Number(deMatch[1]);
    m = Number(deMatch[2]);
    y = Number(deMatch[3]);
  }

  if (!isValidCalendarDate(y, m, d)) {
    throw new Error(`Ungültiges Datum für ${optionLabel}: "${input}" ist kein gültiger Kalendertag.`);
  }

  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function todayIsoLocal() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dateInInclusiveRange(isoDate, fromIso, toIso) {
  return isoDate >= fromIso && isoDate <= toIso;
}

function parseCliOptions(argv) {
  const opts = {
    from: null,
    to: null,
    dateFilter: false,
    fromIso: null,
    toIso: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') {
      if (i + 1 >= argv.length) {
        throw new Error('Option --from erwartet ein Datum (z. B. --from 2025-01-01).');
      }
      opts.from = argv[++i];
    } else if (arg === '--to') {
      if (i + 1 >= argv.length) {
        throw new Error('Option --to erwartet ein Datum (z. B. --to 2025-12-31).');
      }
      opts.to = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unbekannte Option: ${arg}. Nutze --help für die Hilfe.`);
    }
  }

  if (opts.help) return opts;

  opts.dateFilter = opts.from !== null || opts.to !== null;
  if (opts.dateFilter) {
    const currentYear = new Date().getFullYear();
    opts.fromIso = opts.from !== null
      ? parseCliDate(opts.from, '--from')
      : `${currentYear}-01-01`;
    opts.toIso = opts.to !== null
      ? parseCliDate(opts.to, '--to')
      : todayIsoLocal();

    if (opts.fromIso > opts.toIso) {
      throw new Error(
        `Ungültiger Datumsbereich: --from (${opts.fromIso}) liegt nach --to (${opts.toIso}).`
      );
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
🍎 Apple Invoice Downloader v2
═══════════════════════════════════════

VERWENDUNG:
  node apple-invoice-downloader-v2.js [OPTIONEN]

OPTIONEN:
  --from <datum>   Erste Rechnung (inklusive). ISO: YYYY-MM-DD oder TT.MM.JJJJ
  --to <datum>     Letzte Rechnung (inklusive). ISO: YYYY-MM-DD oder TT.MM.JJJJ
  -h, --help       Diese Hilfe anzeigen

BEISPIELE:
  node apple-invoice-downloader-v2.js
  node apple-invoice-downloader-v2.js --from 2025-01-01 --to 2025-12-31
  node apple-invoice-downloader-v2.js --from 01.01.2025 --to 31.12.2025

OHNE --from/--to:
  Scrollt bis Einträge aus dem Vorjahr sichtbar sind und lädt alle sichtbaren Belege
  (sinnvoll für das laufende Steuerjahr).

MIT --from/--to:
  Scrollt so weit, dass der Bereich abgedeckt ist, und lädt nur Rechnungen in diesem
  Zeitraum. Fehlende Grenze: --from = 1. Jan. des aktuellen Jahres, --to = heute.

UNTERSCHIED ZU V1:
  - Sammelt ERST alle Bestellnummern
  - Lädt DANN jede einzeln direkt
  - Robuster, keine Race Conditions
  - Bessere Fehlerbehandlung

═══════════════════════════════════════
  `);
}

function extractDateFromButtonText(buttonText) {
  const dateMatch = buttonText.match(/(\d{1,2}\.\s+\w+\.?\s+\d{4})/);
  return dateMatch ? parseGermanDate(dateMatch[1]) : null;
}

async function scrollPurchaseList(page, { dateFilter, fromIso }) {
  const currentYear = new Date().getFullYear();
  const lastYear = currentYear - 1;
  const maxScrollAttempts = 50;
  let previousCount = 0;
  let scrollAttempts = 0;

  const disclosureSelector =
    'button[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Button.ToggleDisclosure"]';

  if (dateFilter) {
    console.log(`⏬ Scrolle bis Einträge vor ${fromIso} sichtbar sind (Zeitraum ab ${fromIso})...`);
  } else {
    console.log(`⏬ Scrolle bis Einträge aus ${lastYear} sichtbar sind...`);
  }

  while (scrollAttempts < maxScrollAttempts) {
    const currentCount = await page.locator(disclosureSelector).count();
    const allButtons = await page.locator(disclosureSelector).all();

    let stopScrolling = false;

    if (dateFilter) {
      for (const btn of allButtons) {
        const text = await btn.textContent();
        const iso = extractDateFromButtonText(text);
        if (iso && iso < fromIso) {
          console.log(`✅ Einträge vor ${fromIso} gefunden (${currentCount} Käufe geladen)\n`);
          stopScrolling = true;
          break;
        }
      }
    } else {
      for (const btn of allButtons) {
        const text = await btn.textContent();
        if (text.includes(String(lastYear))) {
          console.log(`✅ Einträge aus ${lastYear} gefunden (${currentCount} Käufe geladen)\n`);
          stopScrolling = true;
          break;
        }
      }
    }

    if (stopScrolling) break;

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1500);

    if (currentCount === previousCount) {
      if (dateFilter) {
        console.log(`✅ Ende der Liste erreicht (${currentCount} Käufe, kein Eintrag vor ${fromIso})\n`);
      } else {
        console.log(`✅ Ende der Liste erreicht (${currentCount} Käufe, kein ${lastYear} gefunden)\n`);
      }
      break;
    }

    console.log(`   ${currentCount} Käufe geladen...`);
    previousCount = currentCount;
    scrollAttempts++;
  }

  if (scrollAttempts >= maxScrollAttempts) {
    const finalCount = await page.locator(disclosureSelector).count();
    console.log(`⚠️  Max Scroll-Versuche erreicht (${finalCount} Käufe)\n`);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

async function main(cliOptions) {
  const { chromium } = require('playwright');

  console.log('🍎 Apple Invoice Downloader v2\n');
  console.log('═══════════════════════════════════════\n');
  
  const browser = await chromium.launch({ 
    headless: false,
    slowMo: CONFIG.slowMo
  });
  
  const hasSession = fs.existsSync(CONFIG.sessionFile);
  const context = hasSession 
    ? await browser.newContext({ 
        storageState: CONFIG.sessionFile,
        viewport: { width: 1280, height: 1024 }
      })
    : await browser.newContext({
        viewport: { width: 1280, height: 1024 }
      });
  
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeout);
  
  try {
    // Zu Apple navigieren
    console.log('🌐 Navigiere zu reportaproblem.apple.com...');
    await page.goto('https://reportaproblem.apple.com/', {
      waitUntil: 'networkidle'
    });
    
    // Warten auf Kaufhistorie
    console.log('⏳ Warte auf Kaufhistorie (Login falls nötig)...');
    
    try {
      await page.waitForSelector('button[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Button.ToggleDisclosure"]', {
        timeout: 60000
      });
      
      if (!hasSession) {
        await context.storageState({ path: CONFIG.sessionFile });
        console.log('✅ Session gespeichert!\n');
      } else {
        console.log('✅ Kaufhistorie geladen\n');
      }
      
      // Auf "Alle" umschalten (falls Family Account vorhanden)
      console.log('🔄 Prüfe Account-Auswahl...');
      try {
        const familySelect = page.locator('select[data-auto-test-id="RAP2.FilterPurchases.Select.FamilyMember"]');
        const selectCount = await familySelect.count();
        
        if (selectCount > 0) {
          console.log('   Family Account gefunden - wechsle zu "Alle"');
          await familySelect.selectOption({ label: 'Alle' });
          await page.waitForTimeout(2000);
          await page.waitForSelector('button[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Button.ToggleDisclosure"]');
          console.log('✅ Auf "Alle" umgeschaltet\n');
        } else {
          console.log('✅ Einzelner Account (kein Family Sharing)\n');
        }
      } catch (e) {
        console.log('✅ Einzelner Account (kein Family Sharing)\n');
      }
      
    } catch (error) {
      console.log('\n❌ Fehler beim Laden der Kaufhistorie!');
      throw error;
    }
    
    // SCHRITT 1: Alle Bestellungen sammeln (mit Infinite Scroll)
    console.log('📋 Sammle alle Bestellungen...\n');

    if (cliOptions.dateFilter) {
      console.log(`📅 Filter: Rechnungen von ${cliOptions.fromIso} bis ${cliOptions.toIso} (inklusive)\n`);
    }

    await scrollPurchaseList(page, {
      dateFilter: cliOptions.dateFilter,
      fromIso: cliOptions.fromIso
    });
    
    const orders = [];
    const disclosureButtons = await page.locator('button[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Button.ToggleDisclosure"]').all();
    
    for (let i = 0; i < disclosureButtons.length; i++) {
      try {
        // Wichtig: Buttons NEU laden da React re-rendert
        const buttons = await page.locator('button[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Button.ToggleDisclosure"]').all();
        const button = buttons[i];
        
        const buttonText = await button.textContent();
        
        const dateMatch = buttonText.match(/(\d{1,2}\.\s+\w+\.?\s+\d{4})/);
        const amountMatch = buttonText.match(/([\d,]+)\s*€/);
        const orderIdMatch = buttonText.match(/([A-Z0-9]{10,})/);
        
        if (orderIdMatch) {
          const orderId = orderIdMatch[1];
          const date = dateMatch ? parseGermanDate(dateMatch[1]) : 'unknown';
          const amount = amountMatch ? amountMatch[1].replace(',', '.') : 'unknown';

          if (cliOptions.dateFilter && date !== 'unknown') {
            if (!dateInInclusiveRange(date, cliOptions.fromIso, cliOptions.toIso)) {
              continue;
            }
          }
          
          // Prüfen ob dieser Button bereits expanded ist
          const ariaExpanded = await button.getAttribute('aria-expanded');
          
          // Falls expanded, erst schließen
          if (ariaExpanded === 'true') {
            await button.click();
            await page.waitForTimeout(300);
          }
          
          // Jetzt öffnen
          await button.click();
          await page.waitForTimeout(800); // Mehr Zeit zum Laden
          
          // Prüfen ob Beleg verfügbar ist
          const noInvoice = await page.locator('div[data-auto-test-id="RAP2.PurchaseList.PurchaseDetails.Label.NoInvoice"]').count();
          const hasInvoice = noInvoice === 0;
          
          // Produktname direkt hier extrahieren
          let productName = 'unknown';
          if (hasInvoice) {
            try {
              // Warte kurz damit die Produktliste geladen ist
              await page.waitForTimeout(500);
              
              // Die Produkte sind in .pli-list, nicht in .purchase-details!
              // Wir müssen den parent .purchase Container finden der gerade expanded ist
              
              // Finde alle purchase Container
              const allPurchases = await page.locator('.purchase').all();
              
              // Suche denjenigen mit aria-expanded="true" Button
              let activePurchase = null;
              for (const purchase of allPurchases) {
                const expandButton = await purchase.locator('button[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Button.ToggleDisclosure"]').first();
                const isExpanded = await expandButton.getAttribute('aria-expanded');
                
                if (isExpanded === 'true') {
                  activePurchase = purchase;
                  break;
                }
              }
              
              if (activePurchase) {
                // Hole Produkttitel aus diesem Purchase Container
                const titleDivs = await activePurchase.locator('.pli-title div[aria-label]').all();
                
                if (titleDivs.length > 0) {
                  const names = [];
                  for (let idx = 0; idx < Math.min(titleDivs.length, 2); idx++) {
                    const ariaLabel = await titleDivs[idx].getAttribute('aria-label');
                    if (ariaLabel && ariaLabel.trim()) {
                      names.push(ariaLabel.trim());
                    }
                  }
                  if (names.length > 0) {
                    productName = names.join('_')
                      .substring(0, 40)
                      .replace(/[^a-zA-Z0-9äöüÄÖÜß\s]/g, '')
                      .replace(/\s+/g, '_');
                  }
                }
              } else {
                console.log(`   ⚠️  Kein expanded purchase gefunden`);
              }
            } catch (e) {
              console.log(`   ⚠️  Produktname-Fehler: ${e.message}`);
            }
          }
          
          // Wieder zuklappen
          await button.click();
          await page.waitForTimeout(300);
          
          if (hasInvoice) {
            orders.push({ orderId, date, amount, productName });
            console.log(`✓ ${date} - ${amount}€ - ${productName} - ${orderId}`);
          } else {
            console.log(`⊘ ${date} - ${amount}€ - ${orderId} (kein Beleg)`);
          }
        }
      } catch (e) {
        console.log(`⚠️  Fehler bei Bestellung ${i + 1}: ${e.message}`);
      }
    }
    
    console.log(`\n📦 ${orders.length} Bestellungen mit Belegen gefunden\n`);
    
    if (orders.length === 0) {
      console.log('⚠️  Keine Bestellungen zum Herunterladen gefunden!');
      await browser.close();
      return;
    }
    
    // Download-Ordner vorbereiten
    const downloadPath = path.join(process.cwd(), CONFIG.downloadDir);
    console.log(`📁 Download-Ordner: ${downloadPath}`);
    
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
      console.log('   ✓ Ordner erstellt');
    } else {
      console.log('   ✓ Ordner existiert');
    }
    console.log();
    
    // SCHRITT 2: Jede Bestellung einzeln laden
    console.log('═══════════════════════════════════════');
    console.log('📥 STARTE DOWNLOAD');
    console.log('═══════════════════════════════════════\n');
    
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      console.log(`\n[${i + 1}/${orders.length}] ${order.orderId}`);
      console.log('─'.repeat(40));
      
      try {
        // Zurück zur Hauptseite
        await page.goto('https://reportaproblem.apple.com/', {
          waitUntil: 'networkidle'
        });
        
        // Auf "Alle" schalten (falls vorhanden)
        try {
          const familySelect = page.locator('select[data-auto-test-id="RAP2.FilterPurchases.Select.FamilyMember"]');
          if (await familySelect.count() > 0) {
            await familySelect.selectOption({ label: 'Alle' });
            await page.waitForTimeout(1500);
          }
        } catch (e) {
          // Kein Family Account - einfach weitermachen
        }
        
        // Finde den Button für diese Bestellung
        console.log(`🔍 Suche ${order.orderId}...`);
        
        // Scrolle durch die Liste bis wir die Bestellung finden
        let targetButton = null;
        let scrollAttempts = 0;
        const maxScrollAttempts = 20;
        
        while (!targetButton && scrollAttempts < maxScrollAttempts) {
          const allButtons = await page.locator('button[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Button.ToggleDisclosure"]').all();
          
          // Suche in aktuell geladenen Buttons
          for (const btn of allButtons) {
            const text = await btn.textContent();
            if (text.includes(order.orderId)) {
              targetButton = btn;
              break;
            }
          }
          
          // Wenn gefunden, fertig
          if (targetButton) break;
          
          // Sonst weiter scrollen
          const currentCount = allButtons.length;
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(1000);
          
          // Prüfe ob neue Einträge geladen wurden
          const newCount = await page.locator('button[data-auto-test-id="RAP2.PurchaseList.PurchaseHeader.Button.ToggleDisclosure"]').count();
          
          if (newCount === currentCount) {
            // Keine neuen Einträge mehr
            console.log(`   ⚠️  Ende der Liste erreicht, Bestellung nicht gefunden`);
            break;
          }
          
          scrollAttempts++;
        }
        
        if (!targetButton) {
          console.log('❌ Bestellung nicht gefunden in Liste');
          errorCount++;
          continue;
        }
        
        // Details öffnen
        console.log('📂 Öffne Details...');
        await targetButton.click();
        await page.waitForTimeout(800);
        
        // Produktname aus bereits gesammelten Daten verwenden
        const productName = order.productName || 'unknown';
        console.log(`📦 Produkt: ${productName}`);
        
        // Beleg-Button finden und klicken
        console.log('📄 Öffne Beleg...');
        const invoiceButton = page.locator('button[data-auto-test-id="RAP2.PurchaseList.PurchaseDetails.Button.ViewReceipt"]');
        
        if (await invoiceButton.count() === 0) {
          console.log('❌ Beleg-Button nicht gefunden');
          errorCount++;
          continue;
        }
        
        await invoiceButton.click();
        
        // Warten bis die Rechnung geladen ist
        // (könnte Modal sein oder neue Seite)
        await page.waitForLoadState('networkidle', { timeout: 15000 });
        await page.waitForTimeout(3000); // Extra Zeit zum Rendern
        
        const currentUrl = page.url();
        console.log(`   URL: ...${currentUrl.substring(Math.max(0, currentUrl.length - 50))}`);
        
        // Als PDF speichern
        const filename = sanitizeFilename(`${order.date}_Apple_${order.amount}EUR_${productName}_${order.orderId}.pdf`);
        const filepath = path.join(downloadPath, filename);
        
        console.log('💾 Speichere PDF...');
        console.log(`   Pfad: ${filepath}`);
        
        try {
          await page.pdf({
            path: filepath,
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
          });
          
          console.log('   ✓ PDF-Funktion ausgeführt');
          
          // Prüfe ob Datei existiert
          if (!fs.existsSync(filepath)) {
            console.log('❌ FEHLER: PDF-Datei wurde nicht erstellt!');
            errorCount++;
            continue;
          }
          
          // Prüfe ob PDF nicht leer ist
          const stats = fs.statSync(filepath);
          console.log(`   ✓ Dateigröße: ${stats.size} bytes`);
          
          if (stats.size < 5000) {
            console.log(`⚠️  PDF scheint leer zu sein (${stats.size} bytes)`);
            errorCount++;
          } else {
            console.log(`✅ Gespeichert: ${filename} (${Math.round(stats.size / 1024)}kb)`);
            successCount++;
          }
        } catch (pdfError) {
          console.log(`❌ PDF-Fehler: ${pdfError.message}`);
          errorCount++;
        }
        
      } catch (error) {
        console.log(`❌ Fehler: ${error.message}`);
        errorCount++;
      }
    }
    
    // Zusammenfassung
    console.log('\n\n═══════════════════════════════════════');
    console.log('📊 ZUSAMMENFASSUNG');
    console.log('═══════════════════════════════════════');
    console.log(`✅ Erfolgreich: ${successCount}`);
    console.log(`❌ Fehler: ${errorCount}`);
    console.log(`📁 Gespeichert in: ${downloadPath}`);
    console.log('═══════════════════════════════════════\n');
    
  } catch (error) {
    console.error('\n❌ Kritischer Fehler:', error.message);
    console.error(error.stack);
  } finally {
    await browser.close();
  }
}

// CLI Parameter
const args = process.argv.slice(2);

let cliOptions;
try {
  cliOptions = parseCliOptions(args);
} catch (err) {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
}

if (cliOptions.help) {
  printHelp();
  process.exit(0);
}

// Start
console.log('Starte in 2 Sekunden...\n');
setTimeout(() => {
  main(cliOptions).catch(console.error);
}, 2000);
