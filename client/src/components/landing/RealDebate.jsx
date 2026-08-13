import { Badge, Box, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';

import { ModelBadge } from '../ModelBadge.jsx';

/**
 * ONE REAL DEBATE, VERBATIM.
 *
 * Every word below is copied out of `model_responses` for round
 * f4e7818c-66e9-40a5-a491-d70a6f5c055c, run on 2026-08-11: 28.0 seconds, six
 * calls, 7,007 tokens, $0.0091. The models are the ones that were on the
 * council, the labels are the ones the chairman actually saw, and the
 * concession is a concession that happened.
 *
 * WHY IT IS HARDCODED RATHER THAN FETCHED. The landing page is the only
 * unauthenticated screen with no data of its own, and the alternative — a
 * public endpoint serving a nominated demo round — is a second public data
 * route to secure for a paragraph of text that will never change. This is a
 * quotation, and a quotation is a string.
 *
 * WHY IT IS THE MOST PERSUASIVE THING HERE. It is not a diagram of what the
 * product might do. Gemini 2.5 Flash gave a confident, wrong-in-context answer,
 * was told so by a chairman that had no idea whose answer it was, and withdrew
 * it. Nothing about pasting one prompt into three chat apps produces that, and
 * no mockup of it would be believable.
 *
 * If the copy below is ever edited for length, the round id above must stop
 * being cited. The claim "this is real" is the only reason the section works.
 */
const ROUND = {
  question: 'Is it better to name a boolean field `enabled` or `isEnabled`?',
  meta: '28.0s · 6 calls · 7,007 tokens · $0.0091',
  drafts: [
    {
      label: 'A',
      model: 'GPT-5 Mini',
      body: 'Prefer the name that fits the language and level of exposure — generally use plain adjectives like `enabled` for data fields and `isEnabled` for boolean accessors where the runtime expects a predicate. In Java, naming the field `isEnabled` often yields `isIsEnabled()` from Lombok or JAXB.',
    },
    {
      label: 'B',
      model: 'Gemini 2.5 Flash',
      body: 'It is generally better to name a boolean field `isEnabled`. The `is` prefix clearly indicates the field holds a boolean and reads like a question, making its purpose immediately clear. Many languages and frameworks adopt this convention.',
    },
  ],
  verdict: {
    model: 'Claude Haiku 4.5',
    chip: 'PICKED A',
    reasoning:
      'Response A is accurate and context-aware; Response B makes a factually incorrect claim that `isEnabled` is “generally better” without acknowledging language-specific conventions. A correctly identifies that Java’s JavaBeans pattern uses field `enabled` with getter `isEnabled()`, not field `isEnabled`.',
  },
  rebuttals: [
    {
      label: 'A',
      model: 'GPT-5 Mini',
      stance: 'DEFENDS',
      conceded: false,
      body: 'The chairman’s decision is correct: A recommends following language-specific conventions and warns that naming a field `isEnabled` can produce doubled prefixes like `isIsEnabled()`.',
    },
    {
      label: 'B',
      model: 'Gemini 2.5 Flash',
      stance: 'CONCEDES',
      conceded: true,
      body: 'The chairman is correct. My response made a blanket statement without adequately considering language-specific conventions and tooling issues. Response A provides a much more nuanced and accurate view.',
    },
  ],
  final:
    'The better name depends on your language, framework, and context. Use `enabled` for data fields in Java, JSON keys, database columns and REST payloads. Use `isEnabled` for public properties in C#, Swift and Kotlin, and for methods that return a boolean. Follow your language’s idiom, and avoid negative predicates like `isDisabled`.',
};

export function RealDebate() {
  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end" gap="sm">
        <Box>
          <Text className="quorum-eyebrow">A real debate</Text>
          <Text c="var(--quorum-mute)" mt={4} className="quorum-measure">
            Not a mockup. This round ran on 11 August 2026 and is quoted verbatim — including the
            model that changed its mind.
          </Text>
        </Box>
        <Text size="xs" c="var(--quorum-mute)" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
          {ROUND.meta}
        </Text>
      </Group>

      <Paper
        withBorder
        radius="md"
        p={{ base: 'md', sm: 'lg' }}
        bg="var(--quorum-paper)"
        style={{ borderColor: 'var(--quorum-line)' }}
      >
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
            <Text fz={{ base: 'md', sm: 'lg' }} fw={500}>
              {ROUND.question}
            </Text>
            <Text size="sm" c="var(--quorum-mute)" style={{ flexShrink: 0 }}>
              you
            </Text>
          </Group>

          {/* The same numbered rail as the debate view, at a smaller scale.
              1 and 3 are ink, 2 and 4 are brass, because 2 and 4 are the
              chairman's — one colour rule, three screens. */}
          <Row n="1" heading="Drafts (anonymised, order shuffled)">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              {ROUND.drafts.map((draft) => (
                <MiniCard key={draft.label}>
                  <CardHead
                    model={draft.model}
                    title={`Response ${draft.label}`}
                    subtitle={draft.model}
                  />
                  <Body>{draft.body}</Body>
                </MiniCard>
              ))}
            </SimpleGrid>
          </Row>

          <Row n="2" chairman heading="Verdict">
            <Box
              p="md"
              bg="var(--quorum-brass-bg)"
              style={{
                border: '1px solid var(--quorum-brass-border)',
                borderRadius: 'var(--mantine-radius-md)',
              }}
            >
              <Group gap="sm" mb="xs" wrap="wrap">
                <ModelBadge model={ROUND.verdict.model} size={24} fz={11} />
                <Text fw={700} size="sm">
                  {ROUND.verdict.model}
                </Text>
                <Badge variant="outline" color="brass" radius="xl" size="sm" tt="lowercase" fw={500}>
                  chairman
                </Badge>
                <Badge variant="filled" color="brass" radius="xl" size="sm">
                  {ROUND.verdict.chip}
                </Badge>
              </Group>
              <Body>{ROUND.verdict.reasoning}</Body>
            </Box>
          </Row>

          <Row n="3" heading="Rebuttals">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              {ROUND.rebuttals.map((rebuttal) => (
                <MiniCard key={rebuttal.label} conceded={rebuttal.conceded}>
                  <Group justify="space-between" wrap="nowrap" gap="sm" mb={6}>
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                      <ModelBadge model={rebuttal.model} size={22} fz={10} />
                      <Text fw={700} size="sm" truncate>
                        {rebuttal.model}
                      </Text>
                    </Group>
                    <Badge
                      radius="sm"
                      size="sm"
                      variant={rebuttal.conceded ? 'filled' : 'outline'}
                      color={rebuttal.conceded ? 'green' : 'ink'}
                      style={{ flexShrink: 0 }}
                    >
                      {rebuttal.stance}
                    </Badge>
                  </Group>
                  <Body>{rebuttal.body}</Body>
                </MiniCard>
              ))}
            </SimpleGrid>
          </Row>

          <Row n="4" chairman heading="Final answer" isLast>
            <Box
              p="md"
              bg="var(--quorum-paper)"
              style={{
                border: '2px solid var(--quorum-ink)',
                borderRadius: 'var(--mantine-radius-md)',
              }}
            >
              <Body>{ROUND.final}</Body>
            </Box>
          </Row>
        </Stack>
      </Paper>
    </Stack>
  );
}

/** One stage: the numbered disc and its dashed run, then the content. */
function Row({ n, heading, chairman = false, isLast = false, children }) {
  return (
    <Box style={{ display: 'flex', gap: 'var(--mantine-spacing-md)', alignItems: 'stretch' }}>
      <Box
        visibleFrom="sm"
        style={{ width: 34, display: 'flex', flexDirection: 'column', alignItems: 'center' }}
      >
        <Box
          w={28}
          h={28}
          style={{
            flexShrink: 0,
            borderRadius: 999,
            display: 'grid',
            placeItems: 'center',
            fontWeight: 700,
            fontSize: 13,
            color: '#fff',
            background: chairman ? 'var(--quorum-brass)' : 'var(--quorum-ink)',
          }}
        >
          {n}
        </Box>
        {!isLast && (
          <Box
            style={{
              flex: 1,
              width: 0,
              minHeight: 16,
              margin: '8px 0',
              borderLeft: '2px dashed var(--quorum-line)',
            }}
          />
        )}
      </Box>

      <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
        <Text className="quorum-eyebrow">
          Stage {n} · {heading}
        </Text>
        {children}
      </Stack>
    </Box>
  );
}

function MiniCard({ conceded = false, children }) {
  return (
    <Box
      p="sm"
      bg={conceded ? 'var(--mantine-color-green-0)' : 'var(--quorum-panel)'}
      style={{
        border: `1px solid ${conceded ? 'var(--mantine-color-green-2)' : 'var(--quorum-line)'}`,
        borderRadius: 'var(--mantine-radius-md)',
      }}
    >
      {children}
    </Box>
  );
}

function CardHead({ model, title, subtitle }) {
  return (
    <Group gap="xs" wrap="nowrap" mb={6}>
      <ModelBadge model={model} size={22} fz={10} />
      <Box style={{ minWidth: 0 }}>
        <Text fw={700} size="sm" lh={1.2}>
          {title}
        </Text>
        <Text size="xs" c="var(--quorum-mute)" truncate>
          {subtitle}
        </Text>
      </Box>
    </Group>
  );
}

/** Plain text, not markdown: these are quotations trimmed to fit a card, and
 *  running them through the renderer would invite editing them into markdown. */
function Body({ children }) {
  return (
    <Text size="sm" c="var(--quorum-ink)" style={{ lineHeight: 1.55 }}>
      {children}
    </Text>
  );
}
