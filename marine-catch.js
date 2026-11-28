window.MarineCatch = (() => {
  const storageKey = 'marinecastCatchTrip';
  const {applicable, loadSnapshot, suggestRegion, groundfishContext, photo} = MarineRules;
  const splitSpecies = {
    'Vermilion and sunset rockfish': ['Vermilion rockfish', 'Sunset rockfish'],
    'Kelp and rock greenlings': ['Kelp greenling', 'Rock greenling']
  };
  const slug = name => name.toLowerCase().replaceAll(' ', '-');
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
    const prohibited = species.prohibited || (southernBoat && rule?.class.startsWith('Nearshore'));
    return {
      status: prohibited ? 'retention' : 'conditional',
      combined: method && !(region==='bay' && method==='boat') ? snapshot.groundfish.combined : null,
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
    const details = el('catch-details');
    const status = el('catch-status'), form = el('catch-add'), cards = el('catch-cards');
    let snapshot, catalog = [], trip = null, busy = false, stored = null;
    const expanded = new Set();
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
      if (persist({...trip,catches})) render();
    }

    function counter(row, key) {
      const group = node('div', '', 'catch-counter');
      const label = key === 'retained' ? 'retained' : 'released';
      const output = node('output', String(row[key]));
      output.setAttribute('aria-label', row.name+' '+label+' count');
      for (const [delta,text,action] of [[-1,'−','Remove'],[1,'+','Add']]) {
        const button = node('button',text);
        button.type = 'button';
        button.disabled = trip.state !== 'active' || (delta<0 && row[key]===0) || (delta>0 && row[key]>=9999);
        button.setAttribute('aria-label', action+' '+label+' '+row.name);
        button.dataset.counter = row.id+'-'+key+'-'+delta;
        button.onclick = () => {
          if (key === 'released') expanded.add(row.id);
          saveCounts(trip.catches.map(item=>item.id===row.id ? {...item,[key]:item[key]+delta} : item));
          const next = [...cards.querySelectorAll('button[data-counter]')].find(b=>b.dataset.counter===button.dataset.counter);
          next?.focus({preventScroll:true});
        };
        if (delta===1) group.append(output);
        group.append(button);
      }
      return group;
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
      const options = catalog.filter(species=>!trip?.catches.some(row=>row.id===species.id));
      const previous = select.value;
      select.replaceChildren(new Option('Choose a species',''),...options.map(row=>new Option(row.name,row.id)));
      if (options.some(row=>row.id===previous)) select.value = previous;
      el('catch-add-button').disabled = !options.length;
      const catches = trip?.catches || [];
      const todayKey = today();
      const daily = trip ? [...catches,...getLoggedCatches(trip.date,trip.id)] : [];
      const combined = retainedIn(daily,row=>row.groundfish);
      const shared = node('p');
      if (catches.some(row=>row.groundfish)) {
        const row = catches.find(row=>row.groundfish);
        const cap = limits(snapshot,row,trip,todayKey).combined;
        shared.id = 'catch-combined';
        shared.textContent = Number.isInteger(cap)
          ? 'Combined groundfish · '+combined+' / '+cap+(combined>cap ? ' · Limit exceeded' : ' · '+(cap-combined)+' under cap')
          : 'Combined groundfish · '+combined+' retained · Verified allowance unavailable';
        if (combined>cap && Number.isInteger(cap)) shared.className = 'warn';
      }
      const rows = catches.map(row=>{
        const article = node('article','','catch-row');
        article.dataset.catchSpecies = row.id;
        article.append(node('h3',row.name));
        const species = catalog.find(item=>item.id===row.id) || row;
        const image = species.id==='chinook' && ['inland','delta'].includes(trip.region) ? species.riverImage : species.image;
        if (image?.url) article.append(photo(image,row.name,undefined));
        const {status:regStatus,bag,cap} = limits(snapshot,species,trip,todayKey);
        const intake = retainedIn(daily,item=>row.groundfish ? item.groundfish===row.groundfish : item.id===row.id);
        const ambiguous = row.groundfish && row.id!=='unidentified-rockfish' &&
          daily.some(item=>item.id==='unidentified-rockfish' && item.retained>0);
        if (regStatus==='closed' || regStatus==='retention') {
          article.append(node('p',regStatus==='closed'?'Season closed':'Retention prohibited','warn'));
        }
        if (bag && !['closed','retention'].includes(regStatus)) article.append(node('p','Daily bag limit · '+bag));
        if (Number.isInteger(cap) && intake>cap) article.append(node('p','Limit exceeded · '+intake+' / '+cap,'warn'));
        else if (Number.isInteger(cap) && cap>0 && !ambiguous) {
          article.append(node('p',(row.groundfish?'Sublimit · '+intake+' / '+cap+' · ':'')+
            (cap-intake)+' under '+(row.groundfish?'sublimit':'bag cap')));
        } else if (!['closed','retention'].includes(regStatus) && (!row.groundfish || ambiguous)) {
          article.append(node('p','Verified allowance unavailable','muted'));
        }
        article.append(node('p','Retained','catch-caption'),counter(row,'retained'));
        const released = node('details');
        released.open = expanded.has(row.id);
        released.append(node('summary','Released · '+row.released),counter(row,'released'));
        released.ontoggle = () => {
          if (!released.isConnected) return;
          if (released.open) expanded.add(row.id); else expanded.delete(row.id);
        };
        article.append(released);
        return article;
      });
      cards.replaceChildren(...(shared.id ? [shared] : []),...rows);
      el('catch-rule-note').hidden = !trip;
      el('catch-mismatch').hidden = !trip?.location.suggested || !trip.region || trip.location.suggested===trip.region;
    }

    form.onsubmit = event => {
      event.preventDefault();
      const selected = catalog.find(row=>row.id===select.value);
      if (!selected || trip.state!=='active' || trip.catches.some(row=>row.id===selected.id)) return;
      saveCounts([...trip.catches,{id:selected.id,name:selected.name,groundfish:selected.groundfish,
        prohibited:selected.prohibited,retained:0,released:0}]);
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
