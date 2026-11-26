use quick_xml::Reader;
use quick_xml::escape::{resolve_predefined_entity, unescape};
use quick_xml::events::{BytesStart, Event};
use std::collections::HashMap;

#[derive(Debug, Default, Clone)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    pub text: String,
}

impl Node {
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }

    fn find(&self, name: &str) -> Option<&Node> {
        if self.name == name {
            return Some(self);
        }
        self.children.iter().find_map(|c| c.find(name))
    }

    fn resource_props(&self) -> HashMap<String, String> {
        let mut props = HashMap::new();
        collect_props(self, &mut props);
        for desc in self.children_named("rdf:Description") {
            collect_props(desc, &mut props);
        }
        props
    }

    fn resource_children(&self) -> Vec<&Node> {
        let mut out: Vec<&Node> = Vec::new();
        for c in &self.children {
            if c.name == "rdf:Description" {
                out.extend(c.children.iter());
            } else {
                out.push(c);
            }
        }
        out
    }
}

fn crs_key(name: &str) -> Option<&str> {
    name.strip_prefix("crs:")
}

fn collect_props(node: &Node, props: &mut HashMap<String, String>) {
    for (k, v) in &node.attrs {
        if let Some(key) = crs_key(k) {
            props.insert(key.to_string(), v.clone());
        }
    }
    for c in &node.children {
        if let Some(key) = crs_key(&c.name)
            && c.children.is_empty()
            && !c.text.is_empty()
        {
            props.insert(key.to_string(), c.text.clone());
        }
    }
}

fn decode_text(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    unescape(&s)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| s.into_owned())
}

fn element_from(e: &BytesStart) -> Node {
    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
    let attrs = e
        .attributes()
        .with_checks(false)
        .flatten()
        .map(|a| {
            (
                String::from_utf8_lossy(a.key.as_ref()).into_owned(),
                decode_text(&a.value),
            )
        })
        .collect();
    Node {
        name,
        attrs,
        children: Vec::new(),
        text: String::new(),
    }
}

pub fn parse_tree(xml: &str) -> Result<Node, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut stack: Vec<Node> = vec![Node {
        name: "#root".into(),
        ..Default::default()
    }];

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => stack.push(element_from(&e)),
            Ok(Event::Empty(e)) => {
                let node = element_from(&e);
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                }
            }
            Ok(Event::End(_)) => {
                if stack.len() > 1 {
                    let mut node = stack.pop().unwrap();
                    node.text = node.text.trim().to_string();
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(node);
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if let Some(cur) = stack.last_mut() {
                    cur.text.push_str(&decode_text(&t));
                }
            }
            Ok(Event::CData(t)) => {
                if let Some(cur) = stack.last_mut() {
                    cur.text.push_str(&String::from_utf8_lossy(&t));
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if let Some(cur) = stack.last_mut() {
                    if let Ok(Some(c)) = r.resolve_char_ref() {
                        cur.text.push(c);
                    } else if let Some(text) =
                        resolve_predefined_entity(&String::from_utf8_lossy(&r))
                    {
                        cur.text.push_str(text);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("Invalid XMP: {}", e)),
        }
    }

    while stack.len() > 1 {
        let node = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(node);
    }
    Ok(stack.pop().unwrap())
}

pub type Curve = Vec<(f64, f64)>;

#[derive(Debug, Default, Clone)]
pub struct LookRef {
    pub name: Option<String>,
    pub uuid: Option<String>,
    pub amount: f64,
    pub parameters: Option<Box<CrsDoc>>,
}

#[derive(Debug, Default, Clone)]
pub struct MaskDef {
    pub props: HashMap<String, String>,
}

#[derive(Debug, Default, Clone)]
pub struct Correction {
    pub props: HashMap<String, String>,
    pub masks: Vec<MaskDef>,
    pub curves: HashMap<String, Curve>,
}

#[derive(Debug, Default, Clone)]
pub struct CrsDoc {
    pub settings: HashMap<String, String>,
    pub name: Option<String>,
    pub short_name: Option<String>,
    pub sort_name: Option<String>,
    pub group: Option<String>,
    pub curves: HashMap<String, Curve>,
    pub look: Option<LookRef>,
    pub lens_blur: Option<HashMap<String, String>>,
    pub corrections: Vec<Correction>,
}

impl CrsDoc {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.settings.get(key).map(String::as_str)
    }

    pub fn preset_type(&self) -> &str {
        self.get("PresetType").unwrap_or("Normal")
    }

    pub fn uuid(&self) -> Option<&str> {
        self.get("UUID").filter(|u| !u.is_empty())
    }

    pub fn display_name(&self) -> Option<&str> {
        self.short_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(self.name.as_deref().filter(|s| !s.is_empty()))
    }
}

pub fn parse_number(raw: &str) -> Option<f64> {
    raw.trim().trim_start_matches('+').parse::<f64>().ok()
}

fn alt_text(node: &Node) -> Option<String> {
    let li = node.find("rdf:li")?;
    let text = li.text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn parse_curve(node: &Node) -> Option<Curve> {
    let seq = node.find("rdf:Seq")?;
    let points: Curve = seq
        .children_named("rdf:li")
        .filter_map(|li| {
            let mut it = li.text.split(',').map(str::trim);
            Some((parse_number(it.next()?)?, parse_number(it.next()?)?))
        })
        .collect();
    (points.len() >= 2).then_some(points)
}

const CURVE_NAMES: [&str; 13] = [
    "ToneCurvePV2012",
    "ToneCurvePV2012Red",
    "ToneCurvePV2012Green",
    "ToneCurvePV2012Blue",
    "ToneCurve",
    "ToneCurveRed",
    "ToneCurveGreen",
    "ToneCurveBlue",
    "MainCurve",
    "RedCurve",
    "GreenCurve",
    "BlueCurve",
    "Curve",
];

fn collect_curves(children: &[&Node], curves: &mut HashMap<String, Curve>) {
    for c in children {
        if let Some(key) = crs_key(&c.name)
            && CURVE_NAMES.contains(&key)
            && let Some(points) = parse_curve(c)
        {
            curves.insert(key.to_string(), points);
        }
    }
}

fn collect_masks(node: &Node, masks: &mut Vec<MaskDef>) {
    for c in node.resource_children() {
        if c.name == "crs:CorrectionMasks" || c.name == "rdf:Seq" || c.name == "rdf:Bag" {
            collect_masks(c, masks);
        } else if c.name == "rdf:li" {
            let props = c.resource_props();
            if props
                .get("What")
                .is_some_and(|w| w.starts_with("Mask/") && w != "Mask/Group")
            {
                masks.push(MaskDef { props });
            }
            collect_masks(c, masks);
        }
    }
}

fn parse_corrections(node: &Node) -> Vec<Correction> {
    let Some(seq) = node.find("rdf:Seq") else {
        return Vec::new();
    };
    seq.children_named("rdf:li")
        .map(|li| {
            let props = li.resource_props();
            let children = li.resource_children();
            let mut curves = HashMap::new();
            collect_curves(&children, &mut curves);
            let mut masks = Vec::new();
            for c in &children {
                if c.name == "crs:CorrectionMasks" {
                    collect_masks(c, &mut masks);
                }
            }
            Correction {
                props,
                masks,
                curves,
            }
        })
        .collect()
}

fn doc_from_description(desc: &Node) -> CrsDoc {
    let mut doc = CrsDoc {
        settings: desc.resource_props(),
        ..Default::default()
    };

    let children = desc.resource_children();
    collect_curves(&children, &mut doc.curves);

    for c in children {
        match c.name.as_str() {
            "crs:Name" => doc.name = alt_text(c),
            "crs:ShortName" => doc.short_name = alt_text(c),
            "crs:SortName" => doc.sort_name = alt_text(c),
            "crs:Group" => doc.group = alt_text(c),
            "crs:Look" => {
                let target = c.child("rdf:Description").unwrap_or(c);
                let props = target.resource_props();
                let name = props
                    .get("Name")
                    .cloned()
                    .or_else(|| target.child("crs:Name").and_then(alt_text));
                let parameters = target
                    .resource_children()
                    .into_iter()
                    .find(|n| n.name == "crs:Parameters")
                    .map(|p| {
                        Box::new(doc_from_description(
                            p.child("rdf:Description").unwrap_or(p),
                        ))
                    });
                doc.look = Some(LookRef {
                    name,
                    uuid: props.get("UUID").cloned().filter(|u| !u.is_empty()),
                    amount: props
                        .get("Amount")
                        .and_then(|a| parse_number(a))
                        .unwrap_or(1.0),
                    parameters,
                });
            }
            "crs:LensBlur" => doc.lens_blur = Some(c.resource_props()),
            "crs:MaskGroupBasedCorrections" => doc.corrections = parse_corrections(c),
            _ => {}
        }
    }
    doc
}

pub fn parse_crs(xml: &str) -> Result<CrsDoc, String> {
    let tree = parse_tree(xml)?;
    let desc = find_settings_description(&tree)
        .ok_or_else(|| "No Camera Raw settings found in XMP".to_string())?;
    Ok(doc_from_description(desc))
}

fn find_settings_description(node: &Node) -> Option<&Node> {
    if node.name == "rdf:Description"
        && (node
            .attrs
            .iter()
            .any(|(k, _)| k.starts_with("crs:") || k == "xmlns:crs")
            || node.children.iter().any(|c| c.name.starts_with("crs:")))
    {
        return Some(node);
    }
    node.children
        .iter()
        .find_map(|c| find_settings_description(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Normal" crs:UUID="ABC" crs:Exposure2012="+0.50">
   <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Adaptive Subject - Pop</rdf:li></rdf:Alt></crs:Name>
   <crs:ShortName><rdf:Alt><rdf:li xml:lang="x-default">Pop</rdf:li></rdf:Alt></crs:ShortName>
   <crs:Group><rdf:Alt><rdf:li xml:lang="x-default">B&amp;W</rdf:li></rdf:Alt></crs:Group>
   <crs:Contrast2012>25</crs:Contrast2012>
   <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 240</rdf:li></rdf:Seq></crs:ToneCurvePV2012>
   <crs:Look><rdf:Description crs:Name="Modern 04" crs:Amount="1.22" crs:UUID="D99"/></crs:Look>
   <crs:LensBlur crs:Active="true" crs:BlurAmount="70"/>
   <crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li><rdf:Description crs:CorrectionName="Pop" crs:LocalExposure2012="0.0825">
    <crs:CorrectionMasks><rdf:Seq><rdf:li crs:What="Mask/Image" crs:MaskSubType="1"/></rdf:Seq></crs:CorrectionMasks>
   </rdf:Description></rdf:li></rdf:Seq></crs:MaskGroupBasedCorrections>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#;

    #[test]
    fn parses_all_sections() {
        let doc = parse_crs(SAMPLE).unwrap();
        assert_eq!(doc.get("Exposure2012").and_then(parse_number), Some(0.5));
        assert_eq!(doc.get("Contrast2012").and_then(parse_number), Some(25.0));
        assert_eq!(doc.display_name(), Some("Pop"));
        assert_eq!(doc.group.as_deref(), Some("B&W"));
        assert_eq!(
            doc.curves["ToneCurvePV2012"],
            vec![(0.0, 0.0), (255.0, 240.0)]
        );
        let look = doc.look.unwrap();
        assert_eq!(look.name.as_deref(), Some("Modern 04"));
        assert!((look.amount - 1.22).abs() < 1e-9);
        assert_eq!(doc.lens_blur.unwrap()["BlurAmount"], "70");
        assert_eq!(doc.corrections.len(), 1);
        assert_eq!(doc.corrections[0].masks.len(), 1);
        assert_eq!(doc.corrections[0].masks[0].props["MaskSubType"], "1");
    }
}
