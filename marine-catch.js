window.MarineCatch = (() => {
  const storageKey = 'marinecastCatchTrip';
  const {applicable, loadSnapshot, suggestRegion, groundfishContext, photo} = MarineRules;
  const splitSpecies = {
    'Vermilion and sunset rockfish': ['Vermilion rockfish', 'Sunset rockfish'],
    'Kelp and rock greenlings': ['Kelp greenling', 'Rock greenling']
  };
  const slug = name => name.toLowerCase().replaceAll(' ', '-');
  const categories = [
    ['rockfish','Rockfish'],['salmon','Salmon'],['halibut','Halibut'],['sturgeon','Sturgeon'],
    ['lingcod','Lingcod'],['striped-bass','Striped Bass'],['other','Other supported species']
  ];
  const individualCategory = new Map([
    ['chinook','salmon'],['coho','salmon'],['ca-halibut','halibut'],['pacific-halibut','halibut'],
    ['white-sturgeon','sturgeon'],['green-sturgeon','sturgeon'],['lingcod','lingcod'],['striped-bass','striped-bass']
  ]);
  function categoryOf(row) {
    if (row.groundfish && !['Cabezon','Kelp and rock greenlings'].includes(row.groundfish)) return 'rockfish';
    return individualCategory.get(row.id) || 'other';
  }
  const limitState = (count, cap) => !Number.isInteger(cap) ? 'unknown' :
    count>cap ? 'exceeded' : count===cap ? 'reached' : 'below';

  const retainedIn = (catches, filter) => catches.filter(filter).reduce((sum, row) => sum + row.retained, 0);

  function makeCatalog(snapshot) {
    const species = snapshot.species.filter(row => !snapshot.groundfish.species.includes(row.id))
      .map(row => ({id: row.id, name: row.name, image: row.image, riverImage: row.riverImage}));
    for (const rule of [...snapshot.groundfish.limits, ...snapshot.groundfish.prohibited]) {
      const names = splitSpecies[rule.name] || [rule.name];
      names.forEach((name, index) => species.push({
        id: slug(name), name, image: rule.images?.[index] || rule.image, groundfish: rule.name,
        prohibited: snapshot.groundfish.prohibited.includes(rule)
      }));
    }
    for (const [name, group] of [
      ['Gopher','Nearshore'],['China','Nearshore'],['Black-and-Yellow','Nearshore'],
      ['Olive','Nearshore'],['Yellowtail','Shelf']
    ]) {
      const rule = snapshot.comparisons.species[name];
      const label = name+' rockfish';
      species.push({id:slug(label),name:label,groundfish:label,group,image:rule?.images?.[0]});
    }
    species.push({id:'unidentified-rockfish',name:'Unidentified rockfish',groundfish:'unknown',
      image:snapshot.species.find(row=>row.id==='rockfish')?.image});
    return species.sort((a,b) => a.name.localeCompare(b.name));
  }

  function limits(snapshot, species, trip, today) {
    if (!snapshot || !trip.region || (trip.location.suggested && trip.location.suggested !== trip.region)) return {};
    const {region,date,method} = trip;
    if (!species.groundfish) {
      const {status,restrictions,hasOutdated} = applicable(snapshot.entries[species.id] || [],region,date,today);
      const simple = /^(\d+) (?:fish|crabs)$/.exec(restrictions.bag || '');
      return {status, bag:restrictions.bag,
        cap: status === 'closed' || status === 'retention' ? 0 : simple && status!=='unverified' && !hasOutdated ? Number(simple[1]) : null};
    }
    const {current,southernBoat} = groundfishContext(snapshot.groundfish,region,date,today,method);
    if (!current) return {};
    const rule = snapshot.groundfish.limits.find(row => row.name === species.groundfish);
    const prohibited = species.prohibited || (southernBoat && (rule?.class || species.group)?.startsWith('Nearshore'));
    return {
      status: prohibited ? 'retention' : 'conditional',
      combined: method ? snapshot.groundfish.combined : null,
      cap: prohibited ? 0 : method ? rule?.limit ?? (region==='north' ? rule?.north : rule?.other) : null
    };
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function install({getLocations, formatDate, today, getLoggedCatches, saveToLog}) {
    const el = id => document.getElementById(id);
    const panel = el('catch-page');
    const setup = el('catch-setup'), location = el('catch-location'), date = el('catch-date');
    const region = el('catch-region'), method = el('catch-method'), select = el('catch-species');
    const details = el('catch-details'), category = el('catch-category');
    const group = el('catch-rockfish'), groupTitle = el('catch-rockfish-title');
    const rockfishCards = el('catch-rockfish-cards');
    category.replaceChildren(new Option('Choose a category',''),...categories.map(([id,label])=>new Option(label,id)));
    const status = el('catch-status'), form = el('catch-add'), cards = el('catch-cards');
    let snapshot, catalog = [], trip = null, busy = false, stored = null;
    const rows = new Map();
    const summary = el('catch-summary'), totals = el('catch-totals'), combinedNote = el('catch-combined');
    let optionIds = '';
    const setText = (element, text) => {
      if (element.textContent !== text) element.textContent = text;
    };
    try {
      stored = localStorage.getItem(storageKey);
      const saved = JSON.parse(stored);
      if (saved?.version === 1 && Array.isArray(saved.catches)) trip = saved;
    } catch {}

    function syncStored() {
      const latest = localStorage.getItem(storageKey);
      if (latest === stored) return true;
      stored = latest;
      trip = JSON.parse(latest);
      populateSetup();
      render();
      status.textContent = 'Trip changed in another tab. Review the current counts and try again.';
      return false;
    }

    function persist(next) {
      try {
        if (!syncStored()) return false;
        const value = JSON.stringify(next);
        localStorage.setItem(storageKey, value);
        stored = value;
      } catch {
        status.textContent = 'Unable to save this change on this device.';
        return false;
      }
      trip = next;
      status.textContent = '';
      return true;
    }

    function populateSetup() {
      const {items, selected, selectedDate} = getLocations();
      const saved = trip?.location;
      const options = items.map((item, index) => new Option(item.name,String(index)));
      let index = saved ? items.findIndex(item=>item.name===saved.name && item.latitude===saved.latitude &&
        item.longitude===saved.longitude) : selected;
      if (index === -1 && saved) {
        index = items.length;
        options.push(new Option(saved.name,String(index)));
      }
      location.replaceChildren(...options);
      location.value = String(index);
      date.value = trip?.date || selectedDate || today();
      location.onchange = () => { region.value = suggestRegion(items[Number(location.value)] || saved); };
      region.value = trip?.region || suggestRegion(items[index] || saved);
      method.value = trip?.method || '';
      setup.onsubmit = event => {
        event.preventDefault();
        const chosen = items[Number(location.value)] || saved;
        const next = {...trip, version:1, id:trip?.id || crypto.randomUUID(), state:'active',
          date:date.value, location:{...chosen,suggested:suggestRegion(chosen)},
          region:region.value, method:method.value, catches:trip?.catches || []};
        if (persist(next)) { details.open = false; render(); }
      };
    }

    function saveCounts(catches) {
      if (!persist({...trip,catches})) return false;
      render();
      return true;
    }

    function counter(row, key) {
      const group = node('div', '', 'catch-counter');
      const output = node('output');
      output.setAttribute('aria-label', row.name+' '+key+' count');
      const buttons = [-1,1].map(delta => {
        const button = node('button',delta<0 ? '−' : '+');
        button.type = 'button';
        button.setAttribute('aria-label', (delta<0?'Remove':'Add')+' '+key+' '+row.name);
        button.onclick = () => {
          const current = trip?.catches.find(item=>item.id===row.id);
          if (trip?.state!=='active' || !current) return;
          const count = current[key]+delta;
          if (count<0 || count>9999) return;
          saveCounts(trip.catches.map(item=>item.id===row.id ? {...item,[key]:count} : item));
        };
        return button;
      });
      group.append(buttons[0],output,buttons[1]);
      return {
        group,
        update(count, active) {
          setText(output,String(count));
          buttons[0].disabled = !active || count===0;
          buttons[1].disabled = !active || count>=9999;
        }
      };
    }

    function createRow(row) {
      const article = node('article','','catch-row');
      article.dataset.catchSpecies = row.id;
      const media = node('div','','catch-photo');
      media.hidden = true;
      const retained = counter(row,'retained'), released = counter(row,'released');
      const heading = node('div','','catch-row-heading');
      heading.append(node('h3',row.name),node('p','Retained','catch-caption'),retained.group);
      const top = node('div','','catch-row-top');
      top.append(media,heading);
      const limit = node('p','','catch-limit');
      limit.setAttribute('role','status');
      const other = node('details','','catch-row-options');
      const otherLabel = node('summary');
      const remove = node('button','','catch-remove');
      remove.title = 'Remove species';
      remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16m-10 4v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
      remove.type = 'button';
      remove.setAttribute('aria-label','Remove species '+row.name);
      remove.onclick = () => {
        const current = trip?.catches.find(item=>item.id===row.id);
        if (trip?.state!=='active' || !current) return;
        if ((current.retained || current.released) &&
            !window.confirm('Remove '+row.name+' and its recorded catches from this trip?')) return;
        if (saveCounts(trip.catches.filter(item=>item.id!==row.id))) (select.hidden?category:select).focus();
      };
      other.append(otherLabel,released.group);
      article.append(remove,top,limit,other);
      return {article,media,retained,released,limit,otherLabel,remove,image:undefined};
    }

    function updateRow(view, row, daily, todayKey, active) {
      const species = catalog.find(item=>item.id===row.id) || row;
      const image = species.id==='chinook' && ['inland','delta'].includes(trip.region) ? species.riverImage : species.image;
      if (view.image !== image) {
        view.image = image;
        view.media.replaceChildren(...(image?.url ? [photo(image,row.name,undefined)] : []));
        view.media.hidden = !image?.url;
      }
      const {status:regStatus,bag,cap,combined} = limits(snapshot,species,trip,todayKey);
      const intake = retainedIn(daily,item=>row.groundfish ? item.groundfish===row.groundfish : item.id===row.id);
      const ambiguous = row.groundfish && row.id!=='unidentified-rockfish' &&
        daily.some(item=>item.id==='unidentified-rockfish' && item.retained>0);
      const blocked = regStatus==='closed' || regStatus==='retention';
      const messages = [];
      if (blocked) messages.push(regStatus==='closed'?'Season closed':'Retention prohibited');
      else if (bag) messages.push('Daily bag limit · '+bag);
      const numeric = Number.isInteger(cap);
      const combinedCount = Number.isInteger(combined) ? retainedIn(daily,item=>item.groundfish) : null;

      if (numeric && intake>cap) messages.push('Limit exceeded · '+intake+' / '+cap);
      else if (numeric && cap>0 && !ambiguous) {
        if (intake===cap) messages.push((row.groundfish?'Sublimit':'Bag limit')+' reached · '+intake+' / '+cap);
        else {
          const remaining = (cap-intake)+' under '+(row.groundfish?'sublimit':'bag cap');
          messages.push((row.groundfish?'Sublimit · '+intake+' / '+cap+' · ':'')+remaining);
        }
      } else if (!blocked && row.groundfish && combinedCount!==null && !ambiguous) {
        messages.push('Combined cap · '+combinedCount+' / '+combined+
          (combinedCount>combined ? ' · Limit exceeded' : combinedCount===combined ? ' · Limit reached' : ''));
      } else if (!blocked) messages.push('Verified allowance unavailable');
      if (ambiguous && numeric && cap>0 && intake===cap) messages.push('Known catches reach the sublimit');
      setText(view.limit,messages.join(' · '));
      view.limit.hidden = !messages.length;
      if (messages.length) {
        view.limit.dataset.state = blocked ? 'exceeded' :
          ambiguous && intake<cap ? 'unknown' : numeric ? limitState(intake,cap) : limitState(combinedCount,combined);
      }
      view.retained.update(row.retained,active);
      view.released.update(row.released,active);
      setText(view.otherLabel,'Released · '+row.released);
      view.remove.hidden = !active;
    }

    function render() {
      const active = trip?.state === 'active', complete = trip?.state === 'complete';
      el('catch-context').textContent = trip ? trip.location.name+' · '+formatDate(trip.date) : '';
      el('catch-setup-title').textContent = active ? 'Trip details' : 'Trip setup';
      el('catch-start').textContent = active ? 'Update trip details' : 'Start trip';
      details.hidden = complete;
      form.hidden = !active;
      el('catch-finish').hidden = !active;
      el('catch-save').hidden = !complete;
      el('catch-log').hidden = !complete;
      el('catch-resume').hidden = !complete;
      const added = new Set(trip?.catches.map(row=>row.id));
      const options = catalog.filter(species=>categoryOf(species)===category.value);
      const direct = category.value==='lingcod' || category.value==='striped-bass';
      select.hidden = el('catch-species-label').hidden = !category.value || direct;
      select.required = !select.hidden;
      const ids = options.map(row=>row.id+(added.has(row.id)?':added':'')).join('|');
      if (ids!==optionIds) {
        const previous = select.value;
        optionIds = ids;
        select.replaceChildren(new Option('Choose a species',''),...options.map(row=>{
          const exists = added.has(row.id);
          const option = new Option(row.name+(exists?' · Already added':''),row.id);
          option.disabled = exists;
          return option;
        }));
        if (options.some(row=>row.id===previous && !added.has(row.id))) select.value = previous;
      }
      el('catch-add-button').disabled = !options.some(row=>!added.has(row.id) &&
        row.id===(direct?category.value:select.value));
      const alreadyAdded = direct && options.some(row=>added.has(row.id));
      el('catch-picker-note').hidden = !alreadyAdded;
      setText(el('catch-picker-note'),alreadyAdded?options[0].name+' is already added.':'');
      const catches = trip?.catches || [];
      const todayKey = today();
      const daily = trip ? [...catches,...getLoggedCatches(trip.date,trip.id)] : [];
      const retained = retainedIn(catches,()=>true);
      const released = catches.reduce((sum,row)=>sum+row.released,0);
      summary.hidden = !trip;
      setText(totals,retained+' retained · '+released+' released this trip');
      const groundfish = catches.find(row=>row.groundfish);
      combinedNote.hidden = !groundfish;
      if (groundfish) {
        const combined = retainedIn(daily,row=>row.groundfish);
        const cap = limits(snapshot,groundfish,trip,todayKey).combined;
        const verified = Number.isInteger(cap);
        setText(combinedNote,verified ? 'Combined groundfish · '+combined+' / '+cap+
          (combined>cap ? ' · Limit exceeded' : combined===cap ? ' · Limit reached · 0 under cap' : ' · '+(cap-combined)+' under cap')
          : 'Combined groundfish · '+combined+' retained · Verified allowance unavailable'+
            (!trip.region || !trip.method ? ' · Set waters and method in Trip details' : ''));
        combinedNote.dataset.state = limitState(combined,cap);
      }
      for (const [id,view] of rows) {
        if (catches.some(row=>row.id===id)) continue;
        view.article.remove();
        rows.delete(id);
      }
      const rockfish = catches.filter(row=>categoryOf(row)==='rockfish');
      const hadRockfish = !group.hidden;
      group.hidden = !rockfish.length;
      if (!hadRockfish && rockfish.length) group.open = true;
      setText(groupTitle,'Rockfish · '+retainedIn(rockfish,()=>true)+' retained');
      for (const [container, members] of [[rockfishCards,rockfish],[cards,catches.filter(row=>categoryOf(row)!=='rockfish')]]) {
        let next = container.firstElementChild;
        for (const row of members) {
          if (!rows.has(row.id)) rows.set(row.id,createRow(row));
          const view = rows.get(row.id);
          updateRow(view,row,daily,todayKey,active);
          if (view.article!==next) container.insertBefore(view.article,next);
          next = view.article.nextElementSibling;
        }
      }
      el('catch-rule-note').hidden = !trip;
      el('catch-mismatch').hidden = !trip?.location.suggested || !trip.region || trip.location.suggested===trip.region;
    }

    category.onchange = () => { select.value = '';render(); };
    select.onchange = render;
    form.onsubmit = event => {
      event.preventDefault();
      const selected = catalog.find(row=>row.id===(select.hidden?category.value:select.value) && categoryOf(row)===category.value);
      if (!selected || trip.state!=='active' || trip.catches.some(row=>row.id===selected.id)) return;
      saveCounts([...trip.catches,{id:selected.id,name:selected.name,groundfish:selected.groundfish,
        prohibited:selected.prohibited,group:selected.group,retained:0,released:0}]);
    };
    el('catch-finish').onclick = () => {
      if (persist({...trip,state:'complete'})) render();
    };
    el('catch-resume').onclick = () => { if (persist({...trip,state:'active'})) render(); };
    el('catch-save').onclick = () => {
      const finished = trip;
      if (!finished || finished.state!=='complete') return;
      try { if (!syncStored()) return; } catch {
        status.textContent = 'Unable to read this trip on this device.';
        return;
      }
      const catches = finished.catches.filter(row=>row.retained || row.released);
      const entry = {tripId:finished.id,date:finished.date,location:finished.location.name,
        species:catches.map(row=>row.name).join(', ') || 'No catch',
        count:catches.reduce((sum,row)=>sum+row.retained+row.released,0),catches};
      if (!saveToLog(entry)) return;
      if (persist(null)) {
        details.open = true;
        populateSetup();
        render();
        status.textContent = 'Trip saved to your fishing log.';
      }
    };

    async function refresh() {
      if (panel.hidden) return;
      if (!snapshot && !busy) {
        busy = true;
        try {
          snapshot = await loadSnapshot();
          catalog = makeCatalog(snapshot);
          const keep = region.value;
          region.replaceChildren(new Option('Choose waters',''),...Object.entries(snapshot.regions)
            .map(([id,rule])=>new Option(rule.label,id)));
          region.value = trip?.region || keep || suggestRegion(getLocations().items[getLocations().selected]);
        } catch {
          if (!trip) status.textContent = 'Species list unavailable. Reopen Catch Tracker to retry.';
        } finally {
          busy = false;
        }
      }
      if (!panel.hidden) render();
    }

    details.addEventListener('toggle',()=>{ if (details.open && !panel.hidden) populateSetup(); });
    details.open = !trip;
    populateSetup();
    render();
    new MutationObserver(()=>{
      if (panel.hidden) return;
      populateSetup();
      refresh();
    }).observe(panel,{attributes:true,attributeFilter:['hidden']});
    window.addEventListener('online',refresh);
    window.addEventListener('storage',event=>{
      if (event.key==='marinecastFishingLog' && !panel.hidden) render();
      if (event.key!==storageKey) return;
      try { trip = JSON.parse(event.newValue); stored = event.newValue; } catch { return; }
      if (!panel.hidden) { populateSetup(); render(); }
    });
    setInterval(()=>{ if (!panel.hidden && trip) render(); },60000);
    refresh();
  }

  return {install};
})();
