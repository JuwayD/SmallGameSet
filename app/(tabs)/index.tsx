import React from 'react';
import { Link } from 'expo-router';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

const games = [
  {
    id: 'guess-number',
    title: '联机猜数',
    badge: '1A2B',
    desc: '双人对战猜对方密数，逻辑与节奏并重。',
    meta: ['1-2人', '对战', '逻辑'],
    href: '/guess-number',
  },
];

const merge = (...styles: any[]) => StyleSheet.flatten(styles);

export default function LobbyScreen() {
  const colorScheme = useColorScheme();
  const palette =
    colorScheme === 'dark'
      ? {
          background: '#101114',
          cardBg: '#1b1c22',
          cardBorder: '#2a2b33',
          textMuted: '#b3b6bf',
          glowA: 'rgba(251,191,36,0.18)',
          glowB: 'rgba(251,113,133,0.16)',
          pillBg: 'rgba(255,255,255,0.06)',
          pillBorder: 'rgba(255,255,255,0.2)',
          pillText: '#e5e7eb',
          badgeBg: 'rgba(251,191,36,0.15)',
          badgeBorder: 'rgba(251,191,36,0.45)',
          badgeText: '#fbbf24',
          metaBg: 'rgba(255,255,255,0.05)',
          metaBorder: 'rgba(255,255,255,0.12)',
          buttonBg: '#fbbf24',
          buttonBorder: '#f59e0b',
        }
      : {
          background: '#f6efe6',
          cardBg: '#fff9f2',
          cardBorder: '#f2d9bf',
          textMuted: '#6f6457',
          glowA: 'rgba(246,191,65,0.3)',
          glowB: 'rgba(239,143,130,0.25)',
          pillBg: 'rgba(255,255,255,0.7)',
          pillBorder: '#f1c99c',
          pillText: '#7a5b3a',
          badgeBg: 'rgba(251,191,36,0.2)',
          badgeBorder: '#e0962d',
          badgeText: '#a35617',
          metaBg: 'rgba(255,255,255,0.7)',
          metaBorder: '#f1c99c',
          buttonBg: '#f59e0b',
          buttonBorder: '#e07a10',
        };

  return (
    <View style={merge(styles.root, { backgroundColor: palette.background })}>
      <View
        pointerEvents="none"
        style={merge(styles.glow, styles.glowA, { backgroundColor: palette.glowA })}
      />
      <View
        pointerEvents="none"
        style={merge(styles.glow, styles.glowB, { backgroundColor: palette.glowB })}
      />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <ThemedText type="title" style={merge(styles.title, { fontFamily: Fonts.rounded })}>
            游戏大厅
          </ThemedText>
          <ThemedText style={merge(styles.subtitle, { color: palette.textMuted })}>
            选择游戏进入，后续会持续扩展。
          </ThemedText>
        </View>

        <View style={styles.sectionHeader}>
          <ThemedText type="subtitle" style={styles.sectionTitle}>
            游戏列表
          </ThemedText>
          <View
            style={merge(styles.pill, {
              backgroundColor: palette.pillBg,
              borderColor: palette.pillBorder,
            })}
          >
            <Text style={merge(styles.pillText, { color: palette.pillText })}>当前 1 款可玩</Text>
          </View>
        </View>

        <View style={styles.list}>
          {games.map((game) => (
            <View
              key={game.id}
              style={merge(styles.card, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder })}
            >
              <View style={styles.cardTop}>
                <ThemedText type="subtitle" style={styles.cardTitle}>
                  {game.title}
                </ThemedText>
                <View
                  style={merge(styles.badge, {
                    backgroundColor: palette.badgeBg,
                    borderColor: palette.badgeBorder,
                  })}
                >
                  <Text style={merge(styles.badgeText, { color: palette.badgeText })}>{game.badge}</Text>
                </View>
              </View>
              <ThemedText style={merge(styles.cardDesc, { color: palette.textMuted })}>{game.desc}</ThemedText>
              <View style={styles.metaRow}>
                {game.meta.map((item) => (
                  <View
                    key={item}
                    style={merge(styles.metaTag, {
                      backgroundColor: palette.metaBg,
                      borderColor: palette.metaBorder,
                    })}
                  >
                    <Text style={merge(styles.metaText, { color: palette.textMuted })}>{item}</Text>
                  </View>
                ))}
              </View>
              <Link href={game.href} asChild>
                <TouchableOpacity
                  style={merge(styles.enterBtn, {
                    backgroundColor: palette.buttonBg,
                    borderColor: palette.buttonBorder,
                  })}
                >
                  <Text style={styles.enterText}>进入游戏</Text>
                </TouchableOpacity>
              </Link>
            </View>
          ))}

          <View
            style={merge(
              styles.card,
              styles.cardMuted,
              { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }
            )}
          >
            <View style={styles.cardTop}>
              <ThemedText type="subtitle" style={styles.cardTitle}>
                更多游戏
              </ThemedText>
              <View
                style={merge(styles.badge, {
                  backgroundColor: palette.metaBg,
                  borderColor: palette.metaBorder,
                })}
              >
                <Text style={merge(styles.badgeText, { color: palette.textMuted })}>Coming</Text>
              </View>
            </View>
            <ThemedText style={merge(styles.cardDesc, { color: palette.textMuted })}>
              新玩法正在制作中，欢迎提出想法。
            </ThemedText>
            <View style={styles.metaRow}>
              <View
                style={merge(styles.metaTag, {
                  backgroundColor: palette.metaBg,
                  borderColor: palette.metaBorder,
                })}
              >
                <Text style={merge(styles.metaText, { color: palette.textMuted })}>扩展位</Text>
              </View>
              <View
                style={merge(styles.metaTag, {
                  backgroundColor: palette.metaBg,
                  borderColor: palette.metaBorder,
                })}
              >
                <Text style={merge(styles.metaText, { color: palette.textMuted })}>待上线</Text>
              </View>
            </View>
            <View
              style={merge(
                styles.enterBtn,
                styles.enterBtnDisabled,
                { backgroundColor: palette.metaBg, borderColor: palette.metaBorder }
              )}
            >
              <Text style={merge(styles.enterText, { color: palette.textMuted })}>即将开放</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  glow: {
    position: 'absolute',
    width: 320,
    height: 320,
    borderRadius: 200,
    opacity: 0.9,
  },
  glowA: {
    top: -120,
    left: -80,
  },
  glowB: {
    bottom: -140,
    right: -120,
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  hero: {
    marginBottom: 22,
    gap: 6,
  },
  title: {},
  subtitle: {
    fontSize: 16,
    lineHeight: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 20,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  list: {
    gap: 16,
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
  },
  cardMuted: {
    opacity: 0.6,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: {
    fontSize: 18,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
  },
  cardDesc: {
    marginTop: 10,
    marginBottom: 12,
    lineHeight: 22,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  metaTag: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
  metaText: {
    fontSize: 12,
  },
  enterBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
  },
  enterBtnDisabled: {
    opacity: 0.5,
  },
  enterText: {
    color: '#1a1308',
    fontWeight: '700',
    fontSize: 14,
  },
});
