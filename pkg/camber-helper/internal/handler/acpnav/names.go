package acpnav

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"os/exec"
)

type alliterativeWordSet struct {
	letter     string
	adjectives []string
	nouns      []string
}

var alliterativeWorktreeWords = []alliterativeWordSet{
	{
		letter: "a",
		adjectives: []string{
			"able", "active", "agile", "airy", "alert", "amber", "angled", "aqua", "aquatic", "arctic", "ashen", "athletic", "azure", "afloat", "awash",
		},
		nouns: []string{
			"aft", "alidade", "amidships", "anchor", "anchorline", "anchorwatch", "anchorwell", "anemometer", "aquaplane", "armada", "astrolabe", "azimuth", "anglerail", "airscoop", "autopilot",
		},
	},
	{
		letter: "b",
		adjectives: []string{
			"balanced", "beaming", "billowy", "blue", "blustery", "bold", "bracing", "breakneck", "breezy", "bright", "briny", "brisk", "bubbly", "buoyant", "burnished",
		},
		nouns: []string{
			"backstroke", "bailer", "ballast", "beacon", "bilge", "binnacle", "boat", "boom", "bowline", "bowsprit", "breaker", "breaststroke", "buoy", "bulkhead", "burgee",
		},
	},
	{
		letter: "c",
		adjectives: []string{
			"calm", "cerulean", "charted", "clean", "clear", "clever", "coiling", "cobalt", "cold", "compact", "coral", "crisp", "cruising", "curly", "cyan",
		},
		nouns: []string{
			"cabin", "canoe", "capstan", "catamaran", "centerboard", "channel", "chart", "cleat", "cockpit", "compass", "cuddy", "coxswain", "crew", "cruiser", "current",
		},
	},
	{
		letter: "d",
		adjectives: []string{
			"damp", "dapper", "dark", "dashing", "dauntless", "deep", "deft", "dewy", "dexterous", "direct", "diving", "double", "drifting", "dusky", "dynamic",
		},
		nouns: []string{
			"daggerboard", "davit", "deck", "depth", "desalter", "dinghy", "dive", "diver", "dockline", "dory", "downhaul", "draught", "drift", "drogue", "drysuit",
		},
	},
	{
		letter: "e",
		adjectives: []string{
			"eager", "easy", "ebbing", "ebony", "efficient", "elastic", "electric", "emerald", "enduring", "energetic", "even", "expert", "express", "extra", "elegant",
		},
		nouns: []string{
			"ebb", "echo", "edge", "engine", "ensign", "estuary", "eyelet", "earring", "easting", "ejector", "elbow", "endline", "entry", "equalizer", "escape",
		},
	},
	{
		letter: "f",
		adjectives: []string{
			"fair", "fast", "fearless", "flashing", "fleet", "floating", "fluid", "fluent", "foamy", "focused", "free", "fresh", "frosty", "frothy", "full",
		},
		nouns: []string{
			"fairlead", "fathom", "fender", "ferry", "fin", "flipper", "float", "floodtide", "foil", "footrope", "forecastle", "foredeck", "forestay", "freestyle", "furl",
		},
	},
	{
		letter: "g",
		adjectives: []string{
			"gallant", "generous", "glassy", "gleaming", "gliding", "glimmering", "glossy", "golden", "graceful", "gradual", "green", "gusting", "guided", "gusty", "gutsy",
		},
		nouns: []string{
			"gaff", "galley", "gangway", "gondola", "genoa", "gimbal", "glide", "goggles", "grabline", "grapnel", "grommet", "guardrail", "gunwale", "gybe", "guyline",
		},
	},
	{
		letter: "h",
		adjectives: []string{
			"handy", "hardy", "harboring", "hazy", "headlong", "hearty", "heavy", "helpful", "heroic", "high", "honed", "hot", "hushed", "hydrated", "hydric",
		},
		nouns: []string{
			"halyard", "harbor", "hatch", "hawse", "hawser", "headstay", "helm", "helmsman", "hitch", "horizon", "hull", "hydrofoil", "hydrometer", "hydrophone", "hatchway",
		},
	},
	{
		letter: "i",
		adjectives: []string{
			"icy", "ideal", "idle", "illuminated", "immediate", "imperial", "indigo", "inshore", "instant", "intrepid", "iridescent", "iron", "isobaric", "ivory", "intent",
		},
		nouns: []string{
			"icebreaker", "inboard", "inlet", "insignia", "intake", "isobar", "isogonic", "isotherm", "isthmus", "ivorywake", "indicator", "inflator", "interlock", "ironwork", "idler",
		},
	},
	{
		letter: "j",
		adjectives: []string{
			"jade", "jaunty", "jazzy", "jet", "jewel", "jolly", "joyful", "jubilant", "judicious", "juicy", "jumbo", "jumping", "just", "jointed", "jolting",
		},
		nouns: []string{
			"jackline", "jackstay", "jacket", "jammer", "jib", "jibe", "jigger", "jogger", "joint", "joystick", "journey", "jumpline", "junction", "jury", "jettison",
		},
	},
	{
		letter: "k",
		adjectives: []string{
			"keen", "kelpish", "keyed", "khaki", "kinetic", "kingly", "knitted", "knobby", "knotted", "knowing", "knotty", "kosher", "kind", "kitted", "kraft",
		},
		nouns: []string{
			"kayak", "keel", "keelboat", "keelson", "ketch", "keyway", "kickboard", "kicker", "knot", "knuckle", "knurl", "kedge", "kerf", "kettle", "kiteline",
		},
	},
	{
		letter: "l",
		adjectives: []string{
			"lacquered", "lapis", "lateral", "lean", "level", "light", "lilting", "limber", "lithe", "lively", "lofty", "long", "lucid", "lucky", "luminous",
		},
		nouns: []string{
			"ladder", "lanyard", "latitude", "launch", "leadline", "leeway", "lifeboat", "lifeline", "liferaft", "lift", "lightship", "logbook", "longitude", "lookout", "luff",
		},
	},
	{
		letter: "m",
		adjectives: []string{
			"magenta", "marine", "maritime", "mellow", "mint", "misty", "mobile", "modest", "molten", "moonlit", "mossy", "motile", "moving", "muted", "mystic",
		},
		nouns: []string{
			"mainsail", "marina", "marker", "mast", "masthead", "meridian", "mizzen", "mooring", "motorboat", "mouth", "multihull", "muster", "mainsheet", "midship", "monohull",
		},
	},
	{
		letter: "n",
		adjectives: []string{
			"nautical", "naval", "navy", "nearshore", "neat", "neon", "nimble", "nippy", "nocturnal", "northern", "notable", "novel", "nuclear", "numbered", "nutty",
		},
		nouns: []string{
			"nauticalmile", "navigator", "needle", "netting", "nightwatch", "nipper", "nozzle", "number", "nut", "navigation", "navlight", "neap", "northing", "notch", "navaid",
		},
	},
	{
		letter: "o",
		adjectives: []string{
			"oaken", "oarred", "oceanic", "offshore", "olive", "onyx", "open", "orderly", "outboard", "outer", "outgoing", "overcast", "overt", "overtaking", "oxygenated",
		},
		nouns: []string{
			"oar", "oarlock", "odometer", "offing", "outrigger", "outboard", "outdrive", "outhaul", "overboard", "overfall", "overhang", "oceanway", "oilskin", "orbit", "outlook",
		},
	},
	{
		letter: "p",
		adjectives: []string{
			"paddling", "pale", "pearly", "peppy", "playful", "poised", "polished", "popping", "precise", "prismatic", "proud", "pulsing", "punchy", "pure", "purple",
		},
		nouns: []string{
			"paddle", "painter", "passage", "pennant", "poolfloat", "pilot", "plank", "plunge", "pontoon", "pool", "port", "porthole", "propeller", "prow", "pulley", "pump",
		},
	},
	{
		letter: "q",
		adjectives: []string{
			"qualified", "quality", "quartz", "quayside", "quick", "quickened", "quiet", "quilted", "quirky", "quivering", "quixotic", "quotable", "quenched", "questing", "queued",
		},
		nouns: []string{
			"quadrant", "quay", "quayside", "quarter", "quarterdeck", "quartermaster", "quarters", "quickline", "quickstep", "quickturn", "quiver", "quoin", "quorum", "quest", "queue",
		},
	},
	{
		letter: "r",
		adjectives: []string{
			"radiant", "rapid", "ready", "red", "refreshing", "regal", "resilient", "rhythmic", "rinsed", "rippling", "robust", "rolling", "rosy", "ruddy", "rushing",
		},
		nouns: []string{
			"raft", "rail", "reach", "regatta", "rigger", "rigging", "rinse", "ripple", "rode", "roll", "rope", "rowboat", "rowing", "rudder", "runabout",
		},
	},
	{
		letter: "s",
		adjectives: []string{
			"salty", "sapphire", "spry", "sharp", "shiny", "silver", "sleek", "slick", "smooth", "snappy", "sparkling", "splashy", "steady", "stormy", "swift",
		},
		nouns: []string{
			"sail", "schooner", "scull", "sextant", "sheet", "sidestroke", "skiff", "snorkel", "spinnaker", "splash", "starboard", "stern", "stroke", "swim", "swimcap",
		},
	},
	{
		letter: "t",
		adjectives: []string{
			"tactical", "taut", "teal", "tempered", "tenacious", "tidal", "tight", "tireless", "topaz", "trim", "trusty", "turquoise", "turning", "twin", "twinkling",
		},
		nouns: []string{
			"tack", "telltale", "tender", "tether", "thwart", "tide", "tiller", "timer", "topsail", "topside", "towline", "transom", "trawler", "trim", "turnbuckle",
		},
	},
	{
		letter: "u",
		adjectives: []string{
			"ultramarine", "unbroken", "underwater", "undulant", "unfurled", "united", "unmoored", "upright", "upstream", "urban", "usable", "useful", "utmost", "utter", "unwound",
		},
		nouns: []string{
			"underdeck", "underflow", "undertow", "uniform", "unloader", "uphaul", "upstream", "upwind", "utility", "ultrasonic", "umpire", "unfurl", "unmooring", "upturn", "upperdeck",
		},
	},
	{
		letter: "v",
		adjectives: []string{
			"valiant", "vast", "vaulting", "veering", "velvet", "verdant", "vermilion", "vertical", "vibrant", "vigorous", "violet", "viridian", "vivid", "volant", "voyaging",
		},
		nouns: []string{
			"vang", "vane", "vapor", "vector", "vent", "ventilator", "vessel", "vest", "vigil", "voyage", "voyager", "vortex", "valve", "viewline", "vindicator",
		},
	},
	{
		letter: "w",
		adjectives: []string{
			"warm", "watchful", "wavy", "weathered", "white", "wide", "wild", "willing", "windy", "waterproof", "wakeful", "wise", "wavecut", "wobbly", "woven",
		},
		nouns: []string{
			"wake", "wash", "waverider", "waterline", "wave", "waypoint", "wetsuit", "wheelhouse", "whirlpool", "whistle", "whitecap", "winch", "windlass", "windward", "wingfoil",
		},
	},
	{
		letter: "x",
		adjectives: []string{
			"xanthic", "xanthous", "xenial", "xeric", "xerographic", "xiphoid", "xtra", "xylonic", "xyloid", "xenodochial", "xenolithic", "xerothermic", "xanthochroic", "xenogenic", "xenotropic",
		},
		nouns: []string{
			"xaxis", "xebec", "xenon", "xerarch", "xerophyte", "xiphos", "xmark", "xpost", "xbrace", "xclip", "xcord", "xdrive", "xframe", "xline", "xrail",
		},
	},
	{
		letter: "y",
		adjectives: []string{
			"yare", "yawing", "yellow", "yielding", "young", "youthful", "yonder", "yearly", "yeomanly", "yokewise", "yarely", "yarnlike", "yawled", "yesty", "yoked",
		},
		nouns: []string{
			"yacht", "yard", "yardarm", "yarn", "yaw", "yawl", "yawline", "yawmark", "yawmeter", "yawpoint", "yawrope", "yoke", "yonder", "youngster", "yokeplate",
		},
	},
	{
		letter: "z",
		adjectives: []string{
			"zany", "zealous", "zesty", "zinc", "zippy", "zircon", "zonal", "zooming", "zoetic", "zestful", "zigzag", "zillion", "zoned", "zenithal", "zeroed",
		},
		nouns: []string{
			"zbar", "zenith", "zero", "zigzag", "zinc", "zipline", "zipper", "zone", "zoning", "zoom", "zulu", "zuluclock", "zuluoffset", "zuluwatch", "zdrive",
		},
	},
}

func randomAlliterativeWorktreeName() (string, error) {
	setIdx, err := randomIndex(len(alliterativeWorktreeWords))
	if err != nil {
		return "", err
	}
	set := alliterativeWorktreeWords[setIdx]
	adjectiveIdx, err := randomIndex(len(set.adjectives))
	if err != nil {
		return "", err
	}
	nounIdx, err := randomIndex(len(set.nouns))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%s", set.adjectives[adjectiveIdx], set.nouns[nounIdx]), nil
}

func randomIndex(size int) (int, error) {
	if size <= 0 {
		return 0, fmt.Errorf("cannot choose from %d items", size)
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(size)))
	if err != nil {
		return 0, err
	}
	return int(n.Int64()), nil
}

func uniqueWorktreeName(name string, exists func(string) bool) string {
	if !exists(name) {
		return name
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d", name, suffix)
		if !exists(candidate) {
			return candidate
		}
	}
}

func worktreeBranch(name string) string {
	return fmt.Sprintf("camber/%s", name)
}

func localBranchExists(ctx context.Context, projectPath, branch string) bool {
	cmd := exec.CommandContext(ctx, "git", "-C", projectPath, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	return cmd.Run() == nil
}
