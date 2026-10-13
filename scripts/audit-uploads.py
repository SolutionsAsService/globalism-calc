
import json,glob,os
out=[]
def chk(name,cond,msg):
    if not cond: out.append(f"- **{name}**: {msg}")
up="data/raw/uploads"
for f in sorted(glob.glob(up+"/*.json")):
    d=json.load(open(f)); n=os.path.basename(f); ents=d["entities"]
    if "summary" in d:
        s=d["summary"]; vals=[e for e in ents if e.get("most_recent_value_percent") is not None]
        chk(n,s.get("record_count")==len(ents),f"summary.record_count {s.get('record_count')} != {len(ents)} entities")
        chk(n,s.get("records_with_values")==len(vals),f"summary.records_with_values {s.get('records_with_values')} != {len(vals)}")
        for k in ("minimum_reported_percent","minimum_reported_value_percent"):
            if k in s: chk(n,s[k]==min(e["most_recent_value_percent"] for e in vals),f"summary.{k} {s[k]} != actual min")
        for k in ("maximum_reported_percent","maximum_reported_value_percent"):
            if k in s: chk(n,s[k]==max(e["most_recent_value_percent"] for e in vals),f"summary.{k} {s[k]} != actual max")
        codes={e.get("indicator_code") for e in ents}; chk(n,codes=={d["indicator"]["code"]},f"indicator codes in rows {codes} vs header {d['indicator']['code']}")
        for e in ents:
            v=e.get("most_recent_value_percent"); y=e.get("most_recent_year")
            chk(n,(v is None)==(y is None),f"{e['entity_name']}: value {v} with year {y}")
            chk(n,v is None or 0<=v<=100,f"{e['entity_name']}: value {v} outside 0-100")
            chk(n,(v is None)==(e.get("value_status")!="reported"),f"{e['entity_name']}: value_status {e.get('value_status')} vs value {v}")
            if y is not None and y<2010: out.append(f"- {n}: {e['entity_name']} latest value is from {y} (stale)")
        names=[e["entity_name"] for e in ents]; chk(n,len(names)==len(set(names)),"duplicate entity names")
        chk(n,"dataset_title" in d or "title" in d,"no title")
        if "title" in d and "dataset_title" not in d: out.append(f"- {n}: uses 'title' and 'underlying_source' where the sibling files use 'dataset_title'/'underlying_sources' (inconsistent keys; importer does not depend on them)")
    else:
        g=d["global_totals"]; w=[e for e in ents if e.get("node_type")=="global_aggregate"]
        imp=sum(e["imports_usd"] for e in ents if e.get("node_type")!="global_aggregate"); exp=sum(e["exports_usd"] for e in ents if e.get("node_type")!="global_aggregate")
        out.append(f"- {n}: sum of {len(ents)-len(w)} entities = exports {exp/1e9:.1f} bn, imports {imp/1e9:.1f} bn vs World row exports {g['exports_usd']/1e9:.1f} bn, imports {g['imports_usd']/1e9:.1f} bn (gap = economies not listed)")
        for e in ents:
            nm=e["name"]
            chk(n,e["exports_usd"]==e["exports_thousand_usd"]*1000 and e["imports_usd"]==e["imports_thousand_usd"]*1000,f"{nm}: usd != thousand×1000")
            chk(n,e["trade_balance_usd"]==e["exports_usd"]-e["imports_usd"],f"{nm}: trade_balance {e['trade_balance_usd']} != exports−imports {e['exports_usd']-e['imports_usd']}")
            pos="surplus" if e["trade_balance_usd"]>0 else "deficit" if e["trade_balance_usd"]<0 else "balanced"
            chk(n,e.get("net_trade_position")==pos,f"{nm}: net_trade_position {e.get('net_trade_position')} but balance {e['trade_balance_usd']}")
            chk(n,e["imports_usd"]>=0 and e["exports_usd"]>=0,f"{nm}: negative value")
            if e["imports_usd"]==0: out.append(f"- {n}: {nm} reports zero imports")
        names=[e["name"] for e in ents]; chk(n,len(names)==len(set(names)),"duplicate names")
        out.append(f"- {n}: secondary source (Wikipedia transcription of ITC); provided_by_user=true; source_references are placeholders without bibliographic detail")
print("\n".join(out) if out else "no issues")
