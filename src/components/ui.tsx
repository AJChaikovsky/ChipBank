import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl,
  ScrollView, StyleSheet, Text, TextInput, View, useColorScheme, type StyleProp,
  type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { formatCents, parseDollars } from '@/lib/settle';

// ───────────────────────────────────────────────────────────────── theme ──

const palettes = {
  light: {
    bg: '#F4F5F2', card: '#FFFFFF', text: '#14181A', muted: '#5E676B', border: '#E1E4E0',
    primary: '#0E7A4E', onPrimary: '#FFFFFF', danger: '#C2362B', win: '#0E7A4E', lose: '#C2362B',
    chip: '#E8F3EC',
  },
  dark: {
    bg: '#0D1011', card: '#171B1D', text: '#ECEFEE', muted: '#98A1A4', border: '#262C2E',
    primary: '#34B87C', onPrimary: '#04140C', danger: '#F06A5E', win: '#34B87C', lose: '#F06A5E',
    chip: '#15271E',
  },
};
export type Theme = typeof palettes.light;
export const useTheme = (): Theme => palettes[useColorScheme() === 'dark' ? 'dark' : 'light'];

// ──────────────────────────────────────────────────────────────── layout ──

export function Screen({ children, refreshing, onRefresh }: {
  children: ReactNode; refreshing?: boolean; onRefresh?: () => void;
}) {
  const t = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }, style]}>{children}</View>;
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginVertical: 8 }} />;
}

export function Loading() {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
      <ActivityIndicator color={t.primary} />
    </View>
  );
}

// ────────────────────────────────────────────────────────────────── text ──

type TP = { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number };

export function H1({ children, style }: TP) {
  const t = useTheme();
  return <Text style={[styles.h1, { color: t.text }, style]}>{children}</Text>;
}
export function H2({ children, style }: TP) {
  const t = useTheme();
  return <Text style={[styles.h2, { color: t.text }, style]}>{children}</Text>;
}
export function Body({ children, style, numberOfLines }: TP) {
  const t = useTheme();
  return <Text numberOfLines={numberOfLines} style={[styles.body, { color: t.text }, style]}>{children}</Text>;
}
export function Muted({ children, style, numberOfLines }: TP) {
  const t = useTheme();
  return <Text numberOfLines={numberOfLines} style={[styles.muted, { color: t.muted }, style]}>{children}</Text>;
}

/** Signed money, green for up, red for down. */
export function Money({ cents, style, sign = true }: { cents: number; style?: StyleProp<TextStyle>; sign?: boolean }) {
  const t = useTheme();
  const color = cents > 0 ? t.win : cents < 0 ? t.lose : t.muted;
  return <Text style={[styles.money, { color }, style]}>{formatCents(cents, { sign })}</Text>;
}

// ─────────────────────────────────────────────────────────────── controls ──

type ButtonProps = {
  title: string;
  onPress: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Button({ title, onPress, variant = 'primary', disabled, small, style }: ButtonProps) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const bg = variant === 'primary' ? t.primary : variant === 'danger' ? t.danger : variant === 'secondary' ? t.chip : 'transparent';
  const fg = variant === 'primary' ? t.onPrimary : variant === 'danger' ? '#fff' : t.primary;
  const press = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try { await onPress(); } finally { setBusy(false); }
  };
  return (
    <Pressable
      onPress={press}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button, small && styles.buttonSmall,
        { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy
        ? <ActivityIndicator color={fg} size="small" />
        : <Text style={[styles.buttonText, small && { fontSize: 14 }, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, style, ...props }: TextInputProps & { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label ? <Muted style={{ fontWeight: '600' }}>{label}</Muted> : null}
      <TextInput
        placeholderTextColor={t.muted}
        {...props}
        style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.card }, style]}
      />
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  const t = useTheme();
  if (!children) return null;
  return <Text style={{ color: t.danger, fontSize: 14 }}>{children}</Text>;
}

/** Segmented choice. */
export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.segmented, { borderColor: t.border, backgroundColor: t.bg }]}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)}
            style={[styles.segment, on && { backgroundColor: t.card, borderColor: t.border }]}>
            <Text style={{ color: on ? t.text : t.muted, fontWeight: on ? '700' : '500', fontSize: 14 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────── dialogs ──

/** Cross-platform confirm (Alert isn't implemented on web). */
export function confirm(title: string, message: string, okLabel = 'OK'): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise(resolve => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: okLabel, onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

export function notify(title: string, message?: string) {
  if (Platform.OS === 'web') window.alert(message ? `${title}\n\n${message}` : title);
  else Alert.alert(title, message);
}

export function Sheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: t.card, borderColor: t.border }]}>{children}</View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Dollar-amount entry dialog. Calls onSubmit with integer cents. */
export function AmountSheet({ visible, title, subtitle, initialCents, allowZero, submitLabel = 'Save', onClose, onSubmit }: {
  visible: boolean; title: string; subtitle?: string; initialCents?: number; allowZero?: boolean;
  submitLabel?: string; onClose: () => void; onSubmit: (cents: number) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [lastOpen, setLastOpen] = useState(false);
  if (visible !== lastOpen) {
    setLastOpen(visible);
    if (visible) { setText(initialCents ? (initialCents / 100).toString() : ''); setErr(null); }
  }
  const cents = parseDollars(text);
  const valid = cents !== null && (allowZero ? cents >= 0 : cents > 0);
  return (
    <Sheet visible={visible} onClose={onClose}>
      <H2>{title}</H2>
      {subtitle ? <Muted>{subtitle}</Muted> : null}
      <Field
        autoFocus value={text} onChangeText={setText} placeholder="0.00"
        keyboardType="decimal-pad" inputMode="decimal" style={{ fontSize: 28, fontWeight: '700' }}
      />
      <ErrorText>{err}</ErrorText>
      <Row style={{ gap: 10 }}>
        <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
        <Button
          title={valid ? `${submitLabel} ${formatCents(cents!)}` : submitLabel}
          disabled={!valid}
          style={{ flex: 1 }}
          onPress={async () => {
            try { await onSubmit(cents!); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
          }}
        />
      </Row>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 16, gap: 14, width: '100%', maxWidth: 680, alignSelf: 'center', paddingBottom: 48 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  h1: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  h2: { fontSize: 19, fontWeight: '700' },
  body: { fontSize: 16 },
  muted: { fontSize: 14 },
  money: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  button: { minHeight: 46, borderRadius: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonSmall: { minHeight: 34, paddingHorizontal: 12, borderRadius: 9 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  segmented: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, padding: 3, gap: 3 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: 'transparent' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 16 },
  sheet: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 18, gap: 12, width: '100%', maxWidth: 460, alignSelf: 'center' },
});
