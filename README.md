# River Raid 3D — retrofit

Retrofit em 3D do clássico do Atari 2600, em Three.js. Direção de arte:
**a arte da caixa de 1982, não os pixels** — vale dramático, sol rasante,
avião minúsculo contra paisagem imensa. Ver `src/art/direction.js`.

**Estado: fase 3 — conteúdo.** Vertical slice completa (água refletiva,
terreno pintado com sombras, pós, áudio sintetizado, modelos, VFX) mais:
aviso de combustível no contorno da tela, marcador de posição, raspão com
penalidade de combustível, ilhas com proa, cinco tipos de inimigo com curva
de dificuldade por setor, três biomas com domo de céu, recorde persistente.
Jogável em teclado, toque e gamepad, com tela de início, pausa e mudo.
Dois gates verdes.

```
npm install
npm run dev      # http://127.0.0.1:5173
npm run shots    # gate de mundo e render (headless, SwiftShader)
npm run interact # gate de interação: início, pausa, mudo, toque, game over
npm run single   # build em um único HTML autocontido (dist/river-raid.html)
```

| | Pilotar | Acelerar / frear | Atirar | Pausa |
|---|---|---|---|---|
| Teclado | `A` `D` | `W` `S` | `Espaço` | `P` / `Esc` · `M` som · `Enter` reinicia |
| Toque | arrastar (stick flutuante) | arrastar para cima / baixo | automático ao tocar | botão `II` |
| Gamepad | analógico ou d-pad | gatilhos | `A` / `X` / `RB` | `Start` |

Nada se move até o primeiro input; perder o foco pausa. Parâmetros de URL:
`?engine=a|b|c` (motor), `?debug` (fps, draws, escala), `?auto`, `?warp=N`,
`?lives=N`.

## Arquitetura

| Módulo | Papel |
|---|---|
| `world/river.js` | O mundo como função pura de `(x, z)`: meandro, largura, ilhas, SDF da margem, altura |
| `world/terrain.js` | Chunks em streaming, 1 por frame; casters de sombra janelados |
| `world/terrainMaterial.js` | Albedo por declive/altitude/margem, oclusão pré-calculada por vértice, bounce da parede iluminada |
| `world/water.js` | Reflexão planar (half-res, far 760), refração por profundidade, flow map, espuma pela SDF |
| `view/lighting.js` | Sol rasante com shadow box que segue o jogador e snap a texel; névoa colorida |
| `view/post.js` | Bloom → grade (ACES, saturação, contraste, vinheta, motion blur por reprojeção) → SMAA → grain |
| `view/shapes.js` | Modelos por loft e slab, um template por tipo, clonados |
| `view/fx.js` | Explosões em três tempos, instanciadas, closed-form no vertex shader; congelam no hitstop |
| `view/shaderGuards.js` | Guarda da normal flat-shaded contra `normalize(0)` |
| `audio/` | Motor por RPM sem batimento, reverb do cânion por largura, mixagem que muda com combustível baixo |
| `game/game.js` | Sim a 120 Hz com interpolação; relógio de tensão (combustível); raspão; projéteis hostis com um dono só |
| `game/entities.js` | Navio, helicóptero (rajada com tell), caça, tanque na margem (indesviável, só se desvia), balão de barragem, posto, ponte, pedra de proa; `DIFFICULTY` por setor |
| `view/marker.js` | Sombra de gameplay sob o avião — a sombra física, com sol rasante, cairia deslocada e informaria errado |
| `art/direction.js` | Paleta única **e** `BIOMES`: deserto âmbar (1–2), gorja de basalto (3–4), frio alto (5+), blend de 400 unidades a partir da ponte |
| `core/input.js` | Teclado, toque e gamepad atrás de uma interface analógica; bordas com latch |
| `view/sky.js` | Domo de céu em três paradas que os biomas pintam; a água reflete |
| `core/autopilot.js` | Piloto determinístico — é o harness, não feature |

Decisões que sustentam o resto: mundo como função pura (colisão exata,
determinismo, terreno infinito); zero `Math.random()` na simulação; timestep
fixo com câmera em tempo de frame; **nenhuma cor literal fora de
`direction.js`**.

## Verificação

`npm run shots` sobe o build headless, pilota com o autopilot e captura estados
fixos em `shots/`. Reprova em:

- erro de console **ou warning de GL** — o Chrome reporta draw call descartado
  como warning;
- **frame preto** (luma média do screenshot < 5);
- **morte contra o terreno** — canal impossível é bug, não dificuldade;
- draws > 220 ou triângulos > 800k — tetos derivados da decomposição por passe
  medida em `tools/probe-cost.mjs`, documentada no próprio gate.

- card cobrindo a tela durante o voo.

`npm run interact` cobre o que o piloto automático nunca toca — os caminhos que
uma pessoa usa: tela de início, pausa, mudo, polegar no vidro (eventos de toque
reais via CDP), lockout do game over, e a escala de resolução, acionada pela
própria lentidão do SwiftShader.

Morte para inimigo ou por tanque vazio é reportada, não reprova; cada morte por
tiro registra origem e velocidade do projétil. O piloto roda com `lives=9`
porque game over interrompe a medição — o que se mede é sobrevivência por
trecho, não vidas. Frame time é tendência: SwiftShader não diz nada sobre GPU
real.

Ferramentas de investigação em `tools/`: `bisect.mjs` (trial por patch em
runtime, luma de screenshot real), `probe-nan-object.mjs` (atribui NaN a um
objeto), `probe-gl.mjs` e `probe-tick1.mjs` (atribuem erros de GL a programa
e frame), `probe-cost.mjs` (custo por passe).

## Bugs reais que o harness pegou

Fase 1: ilhas estreitando os canais abaixo da envergadura; piloto mirando
posição em vez de velocidade; overshoot da lei proporcional; escolha de canal
tardia; economia de combustível quebrada; vales interiores inundados.

Fase 2:

1. **Quadro preto intermitente.** `flatShading` deriva a normal por
   `normalize(cross(dFdx, dFdy))`; da câmera espelhada da reflexão sobram
   slivers sub-pixel com derivadas zero → NaN → half-float da reflexão → água
   amostra → cinco mips de bloom espalham pelo frame. Guardado em
   `shaderGuards.js`.
2. **Primeiro frame lixo.** Shadow map nascido dentro de um render para target
   custom sobe mal parametrizado; 31 draws falhavam. Um render de aquecimento
   para o framebuffer padrão resolve.
3. **Espuma como neon.** Calibrada contra a luz placeholder, saturava sob o sol
   novo e cruzava o limiar de bloom.
4. **Gate cego.** `renderer.info.autoReset` zerava as estatísticas a cada passe
   fullscreen; o teto de draw calls lia ~1 e nunca reprovaria.

Fase 3:

5. **Rajada à queima-roupa.** O tell do helicóptero começava numa janela de
   distância, mas a rajada saía depois dele — meio segundo em que o avião fecha
   ~60 unidades. Três mortes com 0,08–0,16 s até o impacto, indesviáveis por
   qualquer um. Piso de distância por tiro; rajada abandonada se o alvo passou.
6. **Piloto cego a projéteis.** Somar empurrões por tiro falha numa rajada
   aberta: esquerda, direita e nada se cancelam e o avião voa no tiro do meio.
   Virou busca de brecha por tempo de interceptação, com qualquer sinal de dz.
7. **Reflexo de inimigo custa igual ao inimigo.** 27 entidades no setor 6
   dobradas pela reflexão: 252 draws. Entidades em layer própria que a câmera
   espelhada não vê; o avião continua refletindo porque é pista de posição.

Rodada "jogável por qualquer um":

8. **O jogo começava sem o jogador.** Dentro de um iframe a página não tem foco
   ao carregar; o avião voava sozinho até bater. Três modos no laço — pronto,
   rodando, pausado — e nada se move antes do primeiro input.
9. **Tiro inimigo invisível.** Dardo no vermelho escuro de acento sobre água
   escura: uma ameaça que o jogador devia desviar e não via. Cor própria em
   HDR, acima do limiar de bloom.
10. **Escala de resolução cega para máquina lenta.** O filtro de hitch
    descartava todo frame acima de 100 ms — ou seja, todos os frames de quem
    roda a 8 fps. Mediana em vez de média filtrada. Pego pelo gate de
    interação.
11. **Título por cima do jogo.** O card nascia visível no HTML e o primeiro
    "esconder" era tratado como não-mudança. Nenhum gate numérico viu; um
    screenshot em retrato viu. Virou gate.

## Como a fase 2 foi feita

Seis agentes em paralelo, cada um dono de um conjunto disjunto de arquivos,
todos lendo `direction.js` e nenhum tocando `main.js`, `terrain.js` ou
`game.js`. Integração, gates e depuração ficaram com um único integrador.
Depuração não paraleliza: os quatro bugs acima só existiam com os módulos
juntos.

## Próximo

Balanceamento com gente jogando: a curva por setor foi desenhada por um agente
e validada só por um piloto que sabe onde está tudo. Escolha do motor de
ouvido. Teste em celular de verdade — toque e retrato foram verificados por
evento sintético e screenshot, não por um polegar. Gate de fps em GPU real.
