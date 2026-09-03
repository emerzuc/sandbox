# River Raid 3D — retrofit

Retrofit em 3D do clássico do Atari 2600, em Three.js. Direção de arte:
**a arte da caixa de 1982, não os pixels** — vale dramático, sol rasante,
avião minúsculo contra paisagem imensa. Ver `src/art/direction.js`.

**Estado: fase 2 concluída — vertical slice jogável.** Água refletiva, terreno
pintado por declive e altitude com sombras, pós-processamento, áudio
inteiramente sintetizado, modelos e VFX. Gate verde.

```
npm install
npm run dev      # http://127.0.0.1:5173
npm run shots    # harness de verificação (headless, SwiftShader)
```

Controles: clique na tela · `A`/`D` mover · `W`/`S` acelerar · `Espaço` atirar
· `Enter` reiniciar.

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
| `game/` | Sim a 120 Hz com interpolação, entidades, colisão contra a mesma função que gerou a malha |
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

Morte para inimigo ou por tanque vazio é reportada, não reprova. Frame time é
tendência: SwiftShader não diz nada sobre GPU real.

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

## Como a fase 2 foi feita

Seis agentes em paralelo, cada um dono de um conjunto disjunto de arquivos,
todos lendo `direction.js` e nenhum tocando `main.js`, `terrain.js` ou
`game.js`. Integração, gates e depuração ficaram com um único integrador.
Depuração não paraleliza: os quatro bugs acima só existiam com os módulos
juntos.

## Próximo

Fase 3: conteúdo — mais tipos de inimigo, curva de dificuldade por setor,
biomas. Antes disso, uma passada de ouvido no áudio (o agente não pôde ouvir
o que fez) e um gate de fps em GPU real.
