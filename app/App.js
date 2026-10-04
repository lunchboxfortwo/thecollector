import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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

const COLORS = {
  bg: '#111111',
  panel: '#1a1815',
  panelAlt: '#211e19',
  text: '#f5f1e8',
  muted: '#a49c8c',
  brass: '#d7af5f',
  line: '#2c2822',
  danger: '#e0795f',
  good: '#7fb069',
};

const EMPTY_HINTS = { artist: '', year: '', country: '', size: '', medium: '' };

function formatMoney(value, currency = 'USD') {
  const n = Math.round(Number(value) || 0);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return symbol + n.toLocaleString('en-US');
}

function prettyDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
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

export default function App() {
  const [screen, setScreen] = useState('input');
  const [mode, setMode] = useState('photo');
  const [image, setImage] = useState(null);
  const [link, setLink] = useState('');
  const [hints, setHints] = useState(EMPTY_HINTS);
  const [result, setResult] = useState(null);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const needsDetails = result?.status === 'needs_details';
  const canSubmit =
    !loading && ((mode === 'photo' && image?.base64) || (mode === 'link' && link.trim().length > 0));

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
    if (asset) setImage(asset);
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
    if (asset) setImage(asset);
  }

  async function submit(extraHints) {
    setLoading(true);
    setError(null);
    const body = {};
    if (mode === 'photo' && image?.base64) {
      body.imageBase64 = image.base64;
      body.mimeType = image.mimeType;
    }
    if (mode === 'link' && link.trim()) {
      body.imageUrl = link.trim();
    }
    const supplied = extraHints || {};
    const cleanHints = {};
    for (const [key, value] of Object.entries(supplied)) {
      if (value && String(value).trim()) cleanHints[key] = String(value).trim();
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
        setScreen('input');
      } else {
        setScreen('value');
      }
    } catch (err) {
      setError(`Could not reach the appraiser at ${base}. Is the backend running?`);
    } finally {
      setLoading(false);
    }
  }

  function backToInput() {
    setScreen('input');
    setResult(null);
    setHints(EMPTY_HINTS);
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {screen === 'input' ? (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <Header subtitle="Appraise a piece from a photo or a link" />
            <ModeToggle mode={mode} onChange={setMode} />
            {mode === 'photo' ? (
              <PhotoPanel image={image} onPick={pickImage} onCapture={captureImage} />
            ) : (
              <LinkPanel link={link} onChange={setLink} />
            )}
            <BackendPanel apiUrl={apiUrl} onChange={setApiUrl} />
            {needsDetails ? (
              <DetailsForm hints={hints} setHints={setHints} onSubmit={() => submit(hints)} />
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <PrimaryButton
              testID="submit-button"
              label={loading ? 'Appraising…' : 'Appraise'}
              disabled={!canSubmit}
              onPress={() => submit(null)}
            />
            <Text style={styles.footnote}>Backend: {normalizeApiUrl(apiUrl)}</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <ValueScreen result={result} onBack={backToInput} />
      )}
    </View>
  );
}

function Header({ subtitle }) {
  return (
    <View style={styles.header}>
      <Text style={styles.wordmark}>THE COLLECTOR</Text>
      <View style={styles.rule} />
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

function ModeToggle({ mode, onChange }) {
  return (
    <View style={styles.toggle}>
      {[
        { key: 'photo', label: 'Photo' },
        { key: 'link', label: 'Link' },
      ].map((item) => {
        const active = mode === item.key;
        return (
          <Pressable
            key={item.key}
            testID={`mode-${item.key}`}
            onPress={() => onChange(item.key)}
            style={[styles.toggleItem, active && styles.toggleItemActive]}
          >
            <Text style={[styles.toggleText, active && styles.toggleTextActive]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function PhotoPanel({ image, onPick, onCapture }) {
  return (
    <View>
      <View style={styles.preview}>
        {image ? (
          <Image source={{ uri: image.uri }} style={styles.previewImage} />
        ) : (
          <Text style={styles.previewPlaceholder}>No photo yet</Text>
        )}
      </View>
      <View style={styles.row}>
        <SecondaryButton testID="take-photo" label="Take photo" onPress={onCapture} />
        <SecondaryButton testID="pick-library" label="Choose photo" onPress={onPick} />
      </View>
    </View>
  );
}

function LinkPanel({ link, onChange }) {
  return (
    <View>
      <Text style={styles.label}>Item URL</Text>
      <TextInput
        testID="url-input"
        style={styles.input}
        value={link}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://…"
        placeholderTextColor={COLORS.muted}
      />
    </View>
  );
}

function BackendPanel({ apiUrl, onChange }) {
  return (
    <View style={styles.backend}>
      <Text style={styles.label}>Backend URL</Text>
      <TextInput
        testID="backend-input"
        style={styles.input}
        value={apiUrl}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder={DEFAULT_API_URL}
        placeholderTextColor={COLORS.muted}
      />
    </View>
  );
}

function DetailsForm({ hints, setHints, onSubmit }) {
  const fields = [
    { key: 'artist', label: 'Artist' },
    { key: 'year', label: 'Year', keyboardType: 'numbers-and-punctuation' },
    { key: 'country', label: 'Country' },
    { key: 'size', label: 'Size (e.g. 50 x 70 cm)' },
    { key: 'medium', label: 'Medium' },
  ];
  return (
    <View style={styles.details}>
      <Text style={styles.detailsTitle}>A few details</Text>
      <Text style={styles.detailsBody}>
        The appraiser could not identify the piece. Add what you know and it will price it from recorded
        auction sales.
      </Text>
      {fields.map((field) => (
        <TextInput
          key={field.key}
          testID={`hint-${field.key}`}
          style={styles.input}
          value={hints[field.key]}
          onChangeText={(value) => setHints({ ...hints, [field.key]: value })}
          placeholder={field.label}
          placeholderTextColor={COLORS.muted}
          autoCapitalize="none"
          keyboardType={field.keyboardType || 'default'}
        />
      ))}
      <SecondaryButton testID="details-submit" label="Price with these details" onPress={onSubmit} />
    </View>
  );
}

function ValueScreen({ result, onBack }) {
  if (!result || result.status === 'refused' || !result.value) {
    const basis = result?.confidence?.basis || ['Nothing to price yet.'];
    return (
      <ScrollView contentContainerStyle={styles.scroll}>
        <Header subtitle="Appraisal result" />
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Not enough to price this</Text>
          {basis.map((line, index) => (
            <Bullet key={index} text={line} />
          ))}
        </View>
        <PrimaryButton testID="back-button" label="Appraise another" onPress={onBack} />
      </ScrollView>
    );
  }

  const { value, confidence, identity, similar, provenance } = result;
  const identified = [
    ['Artist', identity.artist],
    ['Title', identity.title],
    ['Medium', identity.medium],
    ['Dimensions', identity.dimensions],
    ['Year', identity.year],
    ['Country', identity.country],
    ['Edition', identity.edition],
  ].filter(([, v]) => v);

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Header subtitle="Appraisal result" />

      <View style={styles.valueCard}>
        <Text style={styles.valueLabel}>Projected value</Text>
        <Text testID="value-range" style={styles.valueRange}>
          {formatMoney(value.low, value.currency)} – {formatMoney(value.high, value.currency)}
        </Text>
        <View style={styles.confidenceRow}>
          <View style={styles.pill}>
            <Text style={styles.pillText}>
              {String(confidence.level || 'medium').toUpperCase()} confidence
            </Text>
          </View>
          <Text style={styles.confidenceText}>
            {Math.round((confidence.coverage || 0) * 100)}% band · as of {value.as_of}
          </Text>
        </View>
      </View>

      <Section title="Why this value">
        {(confidence.basis || []).map((line, index) => (
          <Bullet key={index} text={line} />
        ))}
      </Section>

      {identified.length ? (
        <Section title="Identified">
          {identified.map(([label, val]) => (
            <View key={label} style={styles.kv}>
              <Text style={styles.kvKey}>{label}</Text>
              <Text style={styles.kvValue}>{String(val)}</Text>
            </View>
          ))}
        </Section>
      ) : null}

      {similar?.length ? (
        <Section title="Similar items">
          {similar.map((item, index) => (
            <View key={item.ref || index} style={styles.similarRow}>
              <View style={styles.similarMain}>
                <Text style={styles.similarTitle} numberOfLines={2}>
                  {item.title || 'Untitled'}
                </Text>
                <Text style={styles.similarMeta} numberOfLines={1}>
                  {[item.artist, item.year || prettyDate(item.sale_date), item.dimensions]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                {item.organization ? (
                  <Text style={styles.similarOrg}>{item.organization}</Text>
                ) : null}
              </View>
              <Text style={styles.similarPrice}>{formatMoney(item.price, item.currency)}</Text>
            </View>
          ))}
        </Section>
      ) : null}

      {provenance?.length ? (
        <Text style={styles.sources}>
          Sources: {(result.sources || []).join(', ') || 'none'} · {provenance.length} matched sales
        </Text>
      ) : null}

      <PrimaryButton testID="back-button" label="Appraise another" onPress={onBack} />
    </ScrollView>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Bullet({ text }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletDot}>•</Text>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

function PrimaryButton({ label, onPress, disabled, testID }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={[styles.primary, disabled && styles.primaryDisabled]}
    >
      {disabled && label === 'Appraising…' ? (
        <ActivityIndicator color={COLORS.bg} />
      ) : (
        <Text style={styles.primaryText}>{label}</Text>
      )}
    </Pressable>
  );
}

function SecondaryButton({ label, onPress, testID }) {
  return (
    <Pressable testID={testID} onPress={onPress} style={styles.secondary}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  scroll: { padding: 20, paddingTop: 56, paddingBottom: 40 },
  header: { marginBottom: 22 },
  wordmark: { color: COLORS.text, fontSize: 20, fontWeight: '700', letterSpacing: 4 },
  rule: { height: 3, width: 64, backgroundColor: COLORS.brass, marginTop: 8, borderRadius: 3 },
  subtitle: { color: COLORS.muted, marginTop: 10, fontSize: 14 },
  toggle: {
    flexDirection: 'row',
    backgroundColor: COLORS.panel,
    borderRadius: 3,
    padding: 4,
    marginBottom: 18,
  },
  toggleItem: { flex: 1, paddingVertical: 10, borderRadius: 3, alignItems: 'center' },
  toggleItemActive: { backgroundColor: COLORS.brass },
  toggleText: { color: COLORS.muted, fontWeight: '600', letterSpacing: 1 },
  toggleTextActive: { color: COLORS.bg },
  label: { color: COLORS.muted, fontSize: 12, marginBottom: 6, letterSpacing: 1 },
  input: {
    backgroundColor: COLORS.panel,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: COLORS.line,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
    fontSize: 15,
  },
  preview: {
    height: 220,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: COLORS.line,
    backgroundColor: COLORS.panel,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    overflow: 'hidden',
  },
  previewImage: { width: '100%', height: '100%' },
  previewPlaceholder: { color: COLORS.muted },
  row: { flexDirection: 'row', gap: 10 },
  backend: { marginTop: 14 },
  details: {
    marginTop: 18,
    padding: 16,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: COLORS.brass,
    backgroundColor: COLORS.panelAlt,
  },
  detailsTitle: { color: COLORS.brass, fontSize: 16, fontWeight: '700', marginBottom: 6, letterSpacing: 1 },
  detailsBody: { color: COLORS.muted, fontSize: 13, marginBottom: 14, lineHeight: 19 },
  primary: {
    backgroundColor: COLORS.brass,
    borderRadius: 3,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryDisabled: { opacity: 0.45 },
  primaryText: { color: COLORS.bg, fontWeight: '700', fontSize: 16, letterSpacing: 1 },
  secondary: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.brass,
    borderRadius: 3,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryText: { color: COLORS.brass, fontWeight: '600' },
  error: { color: COLORS.danger, marginTop: 12, lineHeight: 20 },
  footnote: { color: COLORS.muted, fontSize: 11, marginTop: 16, textAlign: 'center' },
  valueCard: {
    backgroundColor: COLORS.panelAlt,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: COLORS.brass,
    padding: 20,
    marginBottom: 22,
  },
  valueLabel: { color: COLORS.muted, letterSpacing: 2, fontSize: 12 },
  valueRange: { color: COLORS.text, fontSize: 34, fontWeight: '700', marginTop: 8 },
  confidenceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14, gap: 10, flexWrap: 'wrap' },
  pill: { backgroundColor: COLORS.brass, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { color: COLORS.bg, fontWeight: '700', fontSize: 11, letterSpacing: 1 },
  confidenceText: { color: COLORS.muted, fontSize: 12 },
  section: { marginBottom: 18 },
  sectionTitle: { color: COLORS.brass, fontSize: 13, letterSpacing: 2, marginBottom: 8 },
  card: { backgroundColor: COLORS.panel, borderRadius: 3, borderWidth: 1, borderColor: COLORS.line, padding: 16 },
  cardTitle: { color: COLORS.text, fontSize: 17, fontWeight: '700', marginBottom: 10 },
  bulletRow: { flexDirection: 'row', marginBottom: 8 },
  bulletDot: { color: COLORS.brass, marginRight: 8 },
  bulletText: { color: COLORS.text, flex: 1, lineHeight: 20 },
  kv: { flexDirection: 'row', marginBottom: 8 },
  kvKey: { color: COLORS.muted, width: 110 },
  kvValue: { color: COLORS.text, flex: 1 },
  similarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.line,
    paddingVertical: 10,
  },
  similarMain: { flex: 1, paddingRight: 10 },
  similarTitle: { color: COLORS.text, fontSize: 14 },
  similarMeta: { color: COLORS.muted, fontSize: 12, marginTop: 3 },
  similarOrg: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  similarPrice: { color: COLORS.brass, fontWeight: '700' },
  sources: { color: COLORS.muted, fontSize: 11, marginBottom: 8 },
});
