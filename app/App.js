import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';

// Reachable address of the box running the backend, so a real phone can hit it
// over Wi-Fi or Tailscale. Override per-build with EXPO_PUBLIC_API_URL, or in-app.
const DEFAULT_API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://172.93.111.86:3000';

function normalizeApiUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return DEFAULT_API_URL;
  return trimmed.replace(/\/+$/, '');
}

const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' });
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

// Edge-to-edge, so the panels and the reading sheet keep their own insets.
const TOP_INSET = Platform.OS === 'android' ? NativeStatusBar.currentHeight || 24 : 44;
const BOTTOM_INSET = Platform.OS === 'android' ? 12 : 24;

// The exact-build token set, mirroring the audited v3 mock's own markup. The
// colors are the mock's CSS literals and the sizes, outline weights and offset
// shadows are its values, so the build is checkable against the mock rather
// than eyeballed. See `collector-input-chat-mock-v3.html`.
const THEME = {
  color: {
    ink: '#14110f',
    line: '#1a1512',
    paper: '#fffdf7',
    mint: '#cfe8d5',
    blush: '#f3d3d2',
    butter: '#f5e6b8',
    lilac: '#ded4f2',
    sky: '#d3e3f5',
    berry: '#8f2433',
    brass: '#d7af5f',
    cobalt: '#2b4bd6',
    vermilion: '#e2482f',
    chartreuse: '#c7e04a',
    ochre: '#c98a2b',
    teal: '#7fd0c7',
    cream: '#fff4d6',
    body: '#241d17',
    bodySoft: '#3a332c',
    caption: '#584f45',
    placeholder: '#5f574c',
    priceLabel: '#5c4a18',
    headInk: '#4a4136',
  },
  outline: { thin: 2, sheet: 4, focus: 3 },
  radius: { square: 0, pill: 999 },
  shadow: {
    card: { dx: 4, dy: 4, color: '#f5e6b8' },
    price: { dx: 6, dy: 6, color: '#ded4f2' },
    chip: { dx: 3, dy: 3, color: '#d3e3f5' },
    composer: { dx: 4, dy: 4, color: '#d3e3f5' },
    sheet: { dx: 8, dy: -8, color: '#f3d3d2' },
    modal: { dx: 6, dy: 6, color: '#f5e6b8' },
  },
  size: {
    hairline: 2,
    sheetTop: 4,
    send: 40,
    hit: 44,
    chipMin: 44,
    shutter: 92,
    shutterSmall: 64,
    grabW: 46,
    grabH: 5,
    sheetHeight: '66.5%',
  },
  font: { serif: SERIF, mono: MONO },
};
const COLORS = THEME.color;

// The v3 mock's camera panel is a 160deg ochre-to-vermilion gradient and its
// photo wash is a three-stop translucent gradient. Both are baked to small
// stretch images so the panel colors match exactly with no native module.
const CAMERA_GRADIENT = require('./assets/camera-gradient.png');
const PHOTO_WASH = require('./assets/photo-wash.png');

const HINT_FIELDS = [
  { key: 'artist', label: 'Artist' },
  { key: 'year', label: 'Year' },
  { key: 'country', label: 'Country' },
  { key: 'size', label: 'Size' },
  { key: 'medium', label: 'Medium' },
];

function labelForHint(key) {
  return HINT_FIELDS.find((field) => field.key === key)?.label || key;
}

function formatMoney(value, currency = 'USD') {
  const n = Math.round(Number(value) || 0);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return symbol + n.toLocaleString('en-US');
}

async function assetFromResult(result) {
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    base64: asset.base64 || null,
    mimeType: asset.mimeType || 'image/jpeg',
  };
}

// A drawn send arrow: a solid head and a stem, never a Unicode glyph.
function SendGlyph({ color = COLORS.butter, size = 1 }) {
  return (
    <View style={styles.glyph}>
      <View
        style={[
          styles.glyphHead,
          { borderBottomColor: color, borderLeftWidth: 5 * size, borderRightWidth: 5 * size, borderBottomWidth: 7 * size },
        ]}
      />
      <View style={[styles.glyphStem, { backgroundColor: color, width: 2.5 * size, height: 9 * size }]} />
    </View>
  );
}

// Front surface plus a hard offset shadow in a second pastel, drawn as a back
// layer so it renders the same on Android and iOS.
function Hard({ shadow = THEME.shadow.card, front, style, children }) {
  return (
    <View style={[styles.hardOuter, style]}>
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: shadow.color,
            transform: [{ translateX: shadow.dx }, { translateY: shadow.dy }],
          },
        ]}
      />
      <View style={front}>{children}</View>
    </View>
  );
}

function originText(origin) {
  if (!origin) return null;
  if (typeof origin === 'string') return origin;
  if (Array.isArray(origin)) return origin.filter(Boolean).join(' · ');
  return Object.entries(origin)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

export default function App() {
  const { height } = useWindowDimensions();
  const scrollRef = useRef(null);

  const [page, setPage] = useState('landing');
  const [source, setSource] = useState(null);
  const [link, setLink] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hints, setHints] = useState({});
  const [activeHint, setActiveHint] = useState(null);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState([]);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [backendOpen, setBackendOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduceMotion(Boolean(value));
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setReduceMotion(Boolean(value));
    });
    return () => {
      mounted = false;
      sub?.remove?.();
    };
  }, []);

  async function runAppraise(src, options = {}) {
    setLoading(true);
    setError(null);
    const body = {};
    if (src?.base64) {
      body.imageBase64 = src.base64;
      body.mimeType = src.mimeType || 'image/jpeg';
    }
    if (src?.link) body.imageUrl = src.link;
    if (options.note) body.note = options.note;
    const cleanHints = {};
    for (const field of HINT_FIELDS) {
      const value = options.hints?.[field.key];
      if (value && String(value).trim()) cleanHints[field.key] = String(value).trim();
    }
    if (Object.keys(cleanHints).length) body.hints = cleanHints;

    const base = normalizeApiUrl(apiUrl);
    try {
      const res = await fetch(`${base}/appraise`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const json = await res.json();
      setResult(json);
      if (json.status === 'needs_details') {
        // Keep whatever the identifier already filled and only ask for the rest.
        const identified = json.identity || {};
        setHints((prev) => ({
          ...prev,
          artist: prev.artist || identified.artist || '',
          year: prev.year || identified.year || '',
          country: prev.country || identified.country || '',
          size: prev.size || identified.dimensions || '',
          medium: prev.medium || identified.medium || '',
        }));
      }
    } catch (err) {
      setError(`Could not reach the appraiser at ${base}. Is the backend running?`);
    } finally {
      setLoading(false);
    }
  }

  function moveTo(pageName, animated = true) {
    setPage(pageName);
    scrollRef.current?.scrollTo({
      y: pageName === 'reader' ? height : 0,
      animated: animated && !reduceMotion,
    });
  }

  function chooseSource(nextSource) {
    setSource(nextSource);
    setResult(null);
    setError(null);
    setHints({});
    setActiveHint(null);
    setDraft('');
    setTurns([]);
    moveTo('reader', true);
    runAppraise(nextSource, {});
  }

  async function pickImage() {
    setError(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Photo library permission is needed to choose an image.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
      quality: 0.7,
    });
    const asset = await assetFromResult(picked);
    if (asset) chooseSource({ kind: 'photo', ...asset });
  }

  async function captureImage() {
    setError(null);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setError('Camera permission is needed to take a photo.');
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.7 });
    const asset = await assetFromResult(shot);
    if (asset) chooseSource({ kind: 'photo', ...asset });
  }

  function submitLink() {
    const trimmed = link.trim();
    if (!trimmed) return;
    setLinkOpen(false);
    chooseSource({ kind: 'link', link: trimmed, uri: trimmed });
  }

  function sendComposer() {
    const text = draft.trim();
    if (!text || loading) return;
    if (activeHint) {
      const merged = { ...hints, [activeHint]: text };
      setHints(merged);
      setTurns((prev) => [...prev, { id: `t${prev.length}`, label: labelForHint(activeHint), text }]);
      setActiveHint(null);
      setDraft('');
      runAppraise(source, { hints: merged });
    } else {
      setTurns((prev) => [...prev, { id: `t${prev.length}`, label: null, text }]);
      setDraft('');
      runAppraise(source, { note: text });
    }
  }

  function backToSources() {
    moveTo('landing', true);
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.root}>
        <StatusBar style="dark" />
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          pagingEnabled
          scrollEnabled={page === 'landing'}
          showsVerticalScrollIndicator={false}
          onMomentumScrollEnd={(event) => {
            const y = event.nativeEvent.contentOffset.y;
            setPage(y > height / 2 ? 'reader' : 'landing');
          }}
        >
          <View style={{ height }}>
            <Landing
              linkOpen={linkOpen}
              setLinkOpen={setLinkOpen}
              link={link}
              setLink={setLink}
              onSubmitLink={submitLink}
              onPick={pickImage}
              onCapture={captureImage}
              onOpenBackend={() => setBackendOpen(true)}
            />
          </View>
          <View style={{ height }}>
            <Reader
              source={source}
              result={result}
              loading={loading}
              error={error}
              turns={turns}
              hints={hints}
              activeHint={activeHint}
              setActiveHint={setActiveHint}
              draft={draft}
              setDraft={setDraft}
              onSend={sendComposer}
              onBack={backToSources}
            />
          </View>
        </ScrollView>

        <BackendModal
          visible={backendOpen}
          apiUrl={apiUrl}
          onChange={setApiUrl}
          onClose={() => setBackendOpen(false)}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function Landing({
  linkOpen,
  setLinkOpen,
  link,
  setLink,
  onSubmitLink,
  onPick,
  onCapture,
  onOpenBackend,
}) {
  const [urlFocus, setUrlFocus] = useState(false);
  return (
    <View style={styles.landing}>
      <View pointerEvents="none" style={styles.mark}>
        <Text style={styles.markText}>THE COLLECTOR</Text>
      </View>
      <Pressable
        testID="backend-button"
        style={styles.apiPill}
        onPress={onOpenBackend}
        hitSlop={10}
      >
        <Text style={styles.apiPillText}>API</Text>
      </Pressable>

      {linkOpen ? (
        <View style={styles.linkWrap}>
          <View style={styles.linkTop}>
            <Text style={styles.kickOnCobalt}>01 / LINK</Text>
            <View style={[styles.urlField, urlFocus && styles.focusRing]}>
              <TextInput
                testID="url-input"
                style={styles.urlInput}
                value={link}
                onChangeText={setLink}
                onFocus={() => setUrlFocus(true)}
                onBlur={() => setUrlFocus(false)}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://…"
                placeholderTextColor="#5f574c"
                selectionColor={COLORS.berry}
                cursorColor={COLORS.ink}
                onSubmitEditing={onSubmitLink}
              />
              <Pressable
                testID="link-submit"
                style={styles.urlSend}
                onPress={onSubmitLink}
                hitSlop={2}
              >
                <SendGlyph />
              </Pressable>
            </View>
            <Pressable onPress={() => setLinkOpen(false)} style={styles.linkSwitchPress} hitSlop={8}>
              <Text style={styles.linkSwitch}>switch to album · camera</Text>
            </Pressable>
          </View>
          <Pressable testID="panel-camera" style={styles.camPanel} onPress={onCapture}>
            <Image source={CAMERA_GRADIENT} style={styles.fillImage} resizeMode="stretch" />
            <View style={styles.tileCamRowEntry}>
              <View style={styles.tileCol}>
                <Text style={styles.kick}>03 / CAMERA</Text>
                <Text style={styles.tileTitle}>Take a photo</Text>
              </View>
              <View style={[styles.shutter, styles.shutterSmall]} />
            </View>
          </Pressable>
        </View>
      ) : (
        <View style={styles.landingGrid}>
          <View style={styles.landingTop}>
            <Pressable
              testID="panel-link"
              style={[styles.tile, styles.tileLink]}
              onPress={() => setLinkOpen(true)}
            >
              <View style={[styles.blob, styles.blobBlush]} />
              <Text style={styles.kickOnCobalt}>01 / LINK</Text>
              <Text style={styles.titleOnCobalt}>Paste a link</Text>
              <Text style={styles.noteOnCobalt}>auction page, gallery, shop</Text>
            </Pressable>
            <Pressable
              testID="panel-album"
              style={[styles.tile, styles.tileAlbum]}
              onPress={onPick}
            >
              <View style={[styles.blob, styles.blobTeal]} />
              <Text style={styles.kick}>02 / ALBUM</Text>
              <Text style={styles.tileTitle}>From your album</Text>
              <Text style={styles.tileNote}>screenshot or saved photo</Text>
            </Pressable>
          </View>
          <Pressable testID="panel-camera" style={styles.camPanel} onPress={onCapture}>
            <Image source={CAMERA_GRADIENT} style={styles.fillImage} resizeMode="stretch" />
            <View style={styles.slash} />
            <View style={styles.tileCamRow}>
              <View style={styles.tileCol}>
                <Text style={styles.kick}>03 / CAMERA</Text>
                <Text style={styles.tileTitle}>Take a photo</Text>
                <Text style={styles.tileNote}>point, shoot, read</Text>
              </View>
              <View style={styles.shutter} />
            </View>
          </Pressable>
        </View>
      )}

      <Text style={styles.scrollCue}>SCROLL DOWN TO READ THE PIECE</Text>
    </View>
  );
}

function Reader({
  source,
  result,
  loading,
  error,
  turns,
  hints,
  activeHint,
  setActiveHint,
  draft,
  setDraft,
  onSend,
  onBack,
}) {
  const [composerFocus, setComposerFocus] = useState(false);
  const status = loading
    ? 'reading'
    : error
      ? 'offline'
      : result?.status === 'priced'
        ? 'identified'
        : result?.status === 'refused'
          ? 'refused'
          : result?.status === 'needs_details'
            ? 'unsure'
            : 'ready';

  const needsDetails = result?.status === 'needs_details';
  const missing = (result?.missing_fields?.length
    ? result.missing_fields
    : HINT_FIELDS.map((field) => field.key)
  ).map((key) => ({ key }));

  const placeholder = loading
    ? 'Reading the piece…'
    : activeHint
      ? `Type the ${labelForHint(activeHint).toLowerCase()}…`
      : needsDetails
        ? 'Tap a field, or describe the work…'
        : result?.status === 'priced'
          ? 'Add a correction…'
          : 'Type what you know…';

  const method = result?.identity?.method === 'catalog' ? 'catalog' : 'vision';
  const origin = originText(
    result?.origin ?? result?.identity?.origin ?? result?.identity?.country,
  );
  const provenance = Array.isArray(result?.provenance) ? result.provenance : [];
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  const similar = Array.isArray(result?.similar) ? result.similar : [];

  return (
    <View style={styles.reader}>
      {source?.uri ? (
        <Image source={{ uri: source.uri }} style={styles.photo} resizeMode="cover" />
      ) : (
        <View style={styles.photoFallback}>
          <Text style={styles.photoFallbackText}>
            {source?.kind === 'link' ? 'PASTED LINK' : 'NO IMAGE'}
          </Text>
        </View>
      )}
      <Image source={PHOTO_WASH} style={styles.photoWash} resizeMode="stretch" />

      <View style={styles.statusRow}>
        <Pressable testID="back-to-sources" onPress={onBack} style={styles.backPress} hitSlop={10}>
          <Text style={styles.mkchip}>THE COLLECTOR</Text>
        </Pressable>
        <View style={[styles.pill, status === 'unsure' && styles.pillBlush]}>
          <Text testID="status-pill" style={styles.pillText}>
            {status}
          </Text>
        </View>
      </View>

      <Hard
        shadow={THEME.shadow.sheet}
        style={styles.sheetOuter}
        front={styles.sheetFront}
      >
        <View style={styles.grab} />
        <View style={styles.sheetHead}>
          <Text style={styles.sheetHeadText}>READING</Text>
          <Text testID="reading-method" style={styles.sheetHeadText}>
            {method}
          </Text>
        </View>

        <ScrollView
          style={styles.chat}
          contentContainerStyle={styles.chatContent}
          keyboardShouldPersistTaps="handled"
          indicatorStyle="black"
        >
          {turns.map((turn) => (
            <Hard
              key={turn.id}
              shadow={THEME.shadow.card}
              style={[styles.turnOuter]}
              front={styles.userBubble}
            >
              {turn.label ? <Text style={styles.userLabel}>{turn.label}</Text> : null}
              <Text style={styles.userText}>{turn.text}</Text>
            </Hard>
          ))}

          {loading ? (
            <>
              <Text style={styles.sys}>reading the piece</Text>
              <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
                <ActivityIndicator color={COLORS.berry} />
                <Text style={styles.bubbleText}>Reading the image…</Text>
              </Hard>
            </>
          ) : error ? (
            <>
              <Text style={styles.sys}>trouble</Text>
              <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
                <Text style={styles.bubbleText}>{error}</Text>
              </Hard>
            </>
          ) : !result ? (
            <>
              <Text style={styles.sys}>ready</Text>
              <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
                <Text style={styles.bubbleText}>
                  Pick a photo or paste a link, and the piece is read and priced here.
                </Text>
              </Hard>
            </>
          ) : result.status === 'priced' ? (
            <>
              <Text style={styles.sys}>what I can see</Text>
              <IdentityBubble identity={result.identity} />
              <PriceCard result={result} />
              {origin ? <TextCard label="where it came from" body={origin} /> : null}
              {provenance.length || sources.length ? (
                <ProvenanceCard provenance={provenance} sources={sources} />
              ) : null}
              {similar.length ? <SimilarCard items={similar} /> : null}
            </>
          ) : result.status === 'needs_details' ? (
            <>
              <Text style={styles.sys}>what I need</Text>
              <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
                <Text style={styles.bubbleText}>
                  I can&apos;t place this one. Tell me anything you know and I&apos;ll price it from
                  recorded auction sales.
                </Text>
                {(result.confidence?.basis || []).map((line, index) => (
                  <View key={index} style={styles.whyRow}>
                    <Text style={styles.whyDot}>•</Text>
                    <Text style={styles.basisText}>{line}</Text>
                  </View>
                ))}
              </Hard>
            </>
          ) : (
            <>
              <Text style={styles.sys}>what I can&apos;t do</Text>
              <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
                <Text style={styles.bubbleText}>
                  {(result.confidence?.basis || ['I could not price this piece.']).join(' ')}
                </Text>
              </Hard>
            </>
          )}
        </ScrollView>

        {needsDetails && !loading ? (
          <View style={styles.chips}>
            {missing.map(({ key }) => {
              const filled = Boolean(hints[key]);
              const active = activeHint === key;
              return (
                <Hard
                  key={key}
                  shadow={THEME.shadow.chip}
                  style={styles.chipOuter}
                  front={[styles.chipFront, filled && styles.chipFrontFilled, active && styles.chipFrontActive]}
                >
                  <Pressable
                    testID={`hint-chip-${key}`}
                    style={styles.chipPress}
                    onPress={() => setActiveHint(active ? null : key)}
                    hitSlop={4}
                  >
                    <Text style={styles.chipText}>{labelForHint(key)}</Text>
                  </Pressable>
                </Hard>
              );
            })}
          </View>
        ) : null}

        <Hard
          shadow={THEME.shadow.composer}
          style={styles.composerOuter}
          front={[styles.composerFront, composerFocus && styles.focusRing]}
        >
          <TextInput
            testID="composer-input"
            style={styles.composerInput}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setComposerFocus(true)}
            onBlur={() => setComposerFocus(false)}
            placeholder={placeholder}
            placeholderTextColor="#5f574c"
            autoCapitalize="none"
            onSubmitEditing={onSend}
            editable={!loading}
            selectionColor={COLORS.berry}
            cursorColor={COLORS.ink}
          />
          <Pressable
            testID="composer-send"
            style={[styles.send, (!draft.trim() || loading) && styles.sendDisabled]}
            onPress={onSend}
            hitSlop={2}
          >
            <SendGlyph />
          </Pressable>
        </Hard>
      </Hard>
    </View>
  );
}

function IdentityBubble({ identity }) {
  if (!identity?.artist && !identity?.title) {
    return (
      <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
        <Text style={styles.bubbleText}>
          The piece could not be named, but it can still be priced.
        </Text>
      </Hard>
    );
  }
  const meta = [identity.medium, identity.dimensions, identity.year, identity.country, identity.edition]
    .filter(Boolean)
    .join(' · ');
  return (
    <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
      <Text style={styles.identityTitle}>
        {identity.artist || 'Unknown artist'}
        {identity.title ? ` — ${identity.title}` : ''}
      </Text>
      {meta ? <Text style={styles.identityMeta}>{meta}</Text> : null}
    </Hard>
  );
}

function PriceCard({ result }) {
  const { value, confidence } = result;
  return (
    <Hard shadow={THEME.shadow.price} style={styles.priceOuter} front={styles.priceFront}>
      <Text style={styles.priceLabel}>PROJECTED VALUE</Text>
      <Text testID="value-range" style={styles.priceValue}>
        {formatMoney(value.low, value.currency)} – {formatMoney(value.high, value.currency)}
      </Text>
      <Text style={styles.priceMeta}>
        {String(confidence.level || 'medium').toUpperCase()} confidence ·{' '}
        {Math.round((confidence.coverage || 0) * 100)}% band · as of {value.as_of}
      </Text>
      {(confidence.basis || []).map((line, index) => (
        <View key={index} style={styles.whyRow}>
          <Text style={styles.whyDot}>•</Text>
          <Text style={styles.whyText}>{line}</Text>
        </View>
      ))}
    </Hard>
  );
}

function TextCard({ label, body }) {
  return (
    <>
      <Text style={styles.sys}>{label}</Text>
      <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
        <Text style={styles.cardLine}>{body}</Text>
      </Hard>
    </>
  );
}

function ProvenanceCard({ provenance, sources }) {
  return (
    <>
      <Text style={styles.sys}>from the record</Text>
      <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
        {provenance.map((entry, index) => (
          <Text key={index} style={styles.cardLine}>
            {[entry.artist, entry.title].filter(Boolean).join(' — ') || entry.ref || entry.source}
            {entry.sale_date ? ` (${entry.sale_date})` : ''}
          </Text>
        ))}
        {!provenance.length
          ? sources.map((entry, index) => (
              <Text key={index} style={styles.cardLine}>
                {entry}
              </Text>
            ))
          : null}
        {provenance[0]?.source ? <Text style={styles.cardFoot}>{provenance[0].source}</Text> : null}
      </Hard>
    </>
  );
}

function SimilarCard({ items }) {
  return (
    <>
      <Text style={styles.sys}>similar sales</Text>
      <Hard shadow={THEME.shadow.card} style={styles.bubbleOuter} front={styles.bubbleFront}>
        {items.map((item, index) => (
          <View key={index} style={styles.similarRow}>
            <Text style={[styles.cardLine, styles.similarName]}>
              {[item.artist, item.title].filter(Boolean).join(' — ')}
              {item.year ? ` (${item.year})` : ''}
            </Text>
            <Text style={styles.similarPrice}>{formatMoney(item.price, item.currency)}</Text>
          </View>
        ))}
      </Hard>
    </>
  );
}

function BackendModal({ visible, apiUrl, onChange, onClose }) {
  const [focus, setFocus] = useState(false);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Hard shadow={THEME.shadow.modal} style={styles.modalOuter} front={styles.modalCard}>
          <Text style={styles.modalTitle}>BACKEND URL</Text>
          <Text style={styles.modalBody}>The appraiser endpoint this build talks to.</Text>
          <TextInput
            testID="backend-input"
            style={[styles.modalInput, focus && styles.focusRing]}
            value={apiUrl}
            onChangeText={onChange}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={DEFAULT_API_URL}
            placeholderTextColor="#5f574c"
            selectionColor={COLORS.berry}
            cursorColor={COLORS.ink}
          />
          <Pressable style={styles.modalDone} onPress={onClose} hitSlop={4}>
            <Text style={styles.modalDoneText}>DONE</Text>
          </Pressable>
        </Hard>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.ink },
  flex: { flex: 1 },

  // ---------- shared ----------
  hardOuter: { position: 'relative' },
  glyph: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  glyphHead: {
    width: 0,
    height: 0,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginBottom: -1,
  },
  glyphStem: { borderRadius: 2 },
  focusRing: { borderColor: COLORS.berry, borderWidth: 3 },

  // ---------- landing ----------
  landing: { flex: 1, backgroundColor: COLORS.ink },
  landingGrid: { flex: 1 },
  landingTop: { flex: 1, flexDirection: 'row' },
  mark: {
    position: 'absolute',
    top: TOP_INSET + 14,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 4,
  },
  markText: {
    backgroundColor: COLORS.paper,
    borderWidth: 2,
    borderColor: COLORS.line,
    color: COLORS.ink,
    fontFamily: MONO,
    fontSize: 10.5,
    letterSpacing: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    overflow: 'hidden',
  },
  apiPill: {
    position: 'absolute',
    top: TOP_INSET + 12,
    right: 14,
    zIndex: 5,
    borderWidth: 2,
    borderColor: COLORS.line,
    backgroundColor: COLORS.paper,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  apiPillText: { color: COLORS.berry, fontFamily: MONO, fontSize: 10, letterSpacing: 1.5 },
  tile: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 22,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  tileLink: {
    backgroundColor: COLORS.cobalt,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: COLORS.ink,
  },
  tileAlbum: {
    backgroundColor: COLORS.chartreuse,
    borderBottomWidth: 2,
    borderColor: COLORS.ink,
  },
  camPanel: {
    flex: 1,
    backgroundColor: COLORS.ochre,
    overflow: 'hidden',
  },
  tileCamRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 22,
  },
  // The link-entry camera uses the mock's `.le-cam` padding.
  tileCamRowEntry: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingVertical: 24,
  },
  fillImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  tileCol: { flex: 1, justifyContent: 'flex-end' },
  kick: {
    fontFamily: MONO,
    fontSize: 10.5,
    letterSpacing: 1.8,
    color: COLORS.ink,
  },
  kickOnCobalt: {
    fontFamily: MONO,
    fontSize: 10.5,
    letterSpacing: 1.8,
    color: COLORS.paper,
  },
  tileTitle: {
    fontFamily: SERIF,
    fontSize: 25,
    color: COLORS.ink,
    marginTop: 8,
    marginBottom: 5,
  },
  titleOnCobalt: {
    fontFamily: SERIF,
    fontSize: 25,
    color: COLORS.paper,
    marginTop: 8,
    marginBottom: 5,
  },
  tileNote: { fontSize: 11.5, color: COLORS.ink },
  noteOnCobalt: { fontSize: 11.5, color: COLORS.paper },
  blob: { position: 'absolute', borderRadius: 999 },
  blobBlush: { width: 74, height: 74, backgroundColor: COLORS.blush, top: -22, right: -16 },
  blobTeal: { width: 120, height: 120, backgroundColor: COLORS.teal, top: -46, left: -40, opacity: 0.9 },
  slash: {
    position: 'absolute',
    top: 18,
    right: -26,
    width: 150,
    height: 16,
    backgroundColor: '#fff4d6',
    transform: [{ rotate: '-24deg' }],
  },
  shutter: {
    width: THEME.size.shutter,
    height: THEME.size.shutter,
    borderRadius: THEME.size.shutter / 2,
    borderWidth: 3,
    borderColor: COLORS.ink,
    backgroundColor: COLORS.brass,
  },
  shutterSmall: {
    width: THEME.size.shutterSmall,
    height: THEME.size.shutterSmall,
    borderRadius: THEME.size.shutterSmall / 2,
  },
  scrollCue: {
    position: 'absolute',
    bottom: BOTTOM_INSET,
    left: 0,
    right: 0,
    textAlign: 'center',
    zIndex: 3,
    color: COLORS.paper,
    fontFamily: MONO,
    fontSize: 10.5,
    letterSpacing: 2.2,
  },

  // ---------- link entry ----------
  linkWrap: { flex: 1 },
  linkTop: {
    backgroundColor: COLORS.cobalt,
    borderBottomWidth: 2,
    borderColor: COLORS.ink,
    paddingTop: TOP_INSET + 56,
    paddingHorizontal: 22,
    paddingBottom: 24,
  },
  urlField: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.paper,
    borderWidth: 2,
    borderColor: COLORS.line,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 5,
  },
  urlInput: {
    flex: 1,
    color: COLORS.ink,
    fontFamily: MONO,
    fontSize: 13,
    paddingVertical: 8,
  },
  urlSend: {
    width: 40,
    height: 40,
    backgroundColor: COLORS.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkSwitchPress: { marginTop: 6, minHeight: 44, justifyContent: 'center' },
  linkSwitch: { fontSize: 11.5, color: COLORS.paper },
  backPress: { minHeight: 44, justifyContent: 'center' },

  // ---------- reader ----------
  reader: { flex: 1, backgroundColor: COLORS.ink },
  photo: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  photoFallback: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.lilac,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoFallbackText: { color: COLORS.ink, fontFamily: MONO, letterSpacing: 3, fontSize: 12 },
  // The mock's `.photowash` covers the whole photo with a three-stop gradient.
  photoWash: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  statusRow: {
    position: 'absolute',
    top: TOP_INSET + 10,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 3,
  },
  mkchip: {
    color: COLORS.ink,
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: 2.6,
    backgroundColor: COLORS.paper,
    borderWidth: 2,
    borderColor: COLORS.line,
    paddingHorizontal: 9,
    paddingVertical: 5,
    overflow: 'hidden',
  },
  pill: {
    backgroundColor: COLORS.butter,
    borderWidth: 2,
    borderColor: COLORS.line,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  pillBlush: { backgroundColor: COLORS.blush },
  pillText: {
    color: COLORS.ink,
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  sheetOuter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: THEME.size.sheetHeight,
  },
  sheetFront: {
    flex: 1,
    backgroundColor: COLORS.mint,
    borderTopWidth: THEME.size.sheetTop,
    borderColor: COLORS.line,
    borderTopLeftRadius: THEME.radius.square,
    borderTopRightRadius: THEME.radius.square,
    overflow: 'hidden',
    // The mock's second, soft shadow under the hard blush offset.
    elevation: 16,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -16 },
  },
  grab: {
    width: THEME.size.grabW,
    height: THEME.size.grabH,
    backgroundColor: COLORS.line,
    alignSelf: 'center',
    marginTop: 11,
    marginBottom: 5,
  },
  sheetHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 4,
    paddingBottom: 10,
    borderBottomWidth: THEME.outline.thin,
    borderBottomColor: COLORS.line,
  },
  sheetHeadText: {
    color: COLORS.headInk,
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  chat: { flex: 1 },
  chatContent: { paddingHorizontal: 14, paddingTop: 13, paddingBottom: 6 },
  sys: {
    color: COLORS.berry,
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  bubbleOuter: { marginBottom: 14, maxWidth: '94%' },
  bubbleFront: {
    backgroundColor: COLORS.paper,
    borderWidth: 2,
    borderColor: COLORS.line,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  bubbleText: { color: COLORS.body, fontSize: 13.5, lineHeight: 20 },
  identityTitle: { fontFamily: SERIF, fontSize: 16, color: COLORS.body, marginBottom: 4 },
  identityMeta: { color: COLORS.caption, fontFamily: MONO, fontSize: 11.5 },
  priceOuter: { marginBottom: 16, maxWidth: '94%' },
  priceFront: {
    backgroundColor: COLORS.butter,
    borderWidth: 2,
    borderColor: COLORS.line,
    paddingHorizontal: 13,
    paddingVertical: 12,
  },
  priceLabel: {
    color: COLORS.priceLabel,
    fontFamily: MONO,
    fontSize: 10,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  priceValue: { color: COLORS.body, fontSize: 26, fontWeight: '800', marginTop: 6, marginBottom: 3 },
  priceMeta: { color: COLORS.berry, fontFamily: MONO, fontSize: 11, marginBottom: 10 },
  whyRow: { flexDirection: 'row', marginBottom: 6 },
  whyDot: { color: COLORS.berry, marginRight: 8, fontSize: 12 },
  whyText: { color: COLORS.bodySoft, fontSize: 11.8, lineHeight: 18, flex: 1 },
  basisText: { color: COLORS.bodySoft, fontSize: 12, lineHeight: 18, flex: 1 },
  cardLine: { color: COLORS.body, fontSize: 12.5, lineHeight: 18, marginBottom: 5 },
  cardFoot: { color: COLORS.caption, fontFamily: MONO, fontSize: 10.5, marginTop: 3 },
  similarRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  similarName: { flex: 1, marginRight: 10 },
  similarPrice: { color: COLORS.berry, fontFamily: MONO, fontSize: 11.5 },
  turnOuter: { alignSelf: 'flex-end', marginBottom: 12, maxWidth: '86%' },
  userBubble: {
    backgroundColor: COLORS.paper,
    borderWidth: 2,
    borderColor: COLORS.line,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  userLabel: {
    color: COLORS.berry,
    fontFamily: MONO,
    fontSize: 9.5,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  userText: { color: COLORS.body, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingBottom: 2 },
  chipOuter: { marginRight: 8, marginBottom: 8 },
  chipFront: { backgroundColor: COLORS.paper, borderWidth: 2, borderColor: COLORS.line },
  chipFrontFilled: { backgroundColor: COLORS.butter },
  chipFrontActive: { backgroundColor: COLORS.sky },
  chipPress: {
    minHeight: THEME.size.chipMin,
    minWidth: THEME.size.chipMin,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 15,
  },
  chipText: { color: COLORS.ink, fontSize: 12.5 },
  composerOuter: { marginHorizontal: 14, marginTop: 8, marginBottom: BOTTOM_INSET + 4 },
  composerFront: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.paper,
    borderWidth: 2,
    borderColor: COLORS.line,
    paddingLeft: 15,
    paddingRight: 8,
    paddingVertical: 8,
  },
  composerInput: { flex: 1, color: COLORS.ink, fontSize: 13, paddingVertical: 6 },
  send: {
    flexGrow: 0,
    flexShrink: 0,
    width: THEME.size.send,
    height: THEME.size.send,
    backgroundColor: COLORS.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.45 },

  // ---------- backend modal ----------
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,17,15,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalOuter: { width: '100%' },
  modalCard: {
    backgroundColor: COLORS.paper,
    borderWidth: 2,
    borderColor: COLORS.line,
    padding: 20,
  },
  modalTitle: {
    color: COLORS.berry,
    fontFamily: MONO,
    fontSize: 12,
    letterSpacing: 2,
    marginBottom: 6,
  },
  modalBody: { color: COLORS.caption, fontSize: 12.5, marginBottom: 14, lineHeight: 18 },
  modalInput: {
    backgroundColor: COLORS.mint,
    borderWidth: 2,
    borderColor: COLORS.line,
    color: COLORS.ink,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 14,
    fontSize: 14,
  },
  modalDone: {
    minHeight: THEME.size.hit,
    backgroundColor: COLORS.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalDoneText: { color: COLORS.butter, fontWeight: '700', letterSpacing: 1.5 },
});
