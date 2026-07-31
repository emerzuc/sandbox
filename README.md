# River Raid 3D — retrofit

Retrofit em 3D do clássico do Atari 2600, em Three.js.

**Estado: fase 1 concluída — greybox jogável.** Sem uma textura, sem um asset.
O objetivo desta fase é uma coisa só: descobrir se o jogo é bom *antes* de
existir arte para escondê-lo.

```
npm install
npm run dev      # http://127.0.0.1:5173
npm run shots    # harness de verificação (headless)
```

Controles: `A`/`D` mover · `W`/`S` acelerar · `Espaço` atirar · `Enter` reiniciar.

## O que já existe

| Sistema | Estado |
|---|---|
| Simulação a 120 Hz com interpolação de render | ✅ |
| Rio procedural infinito (meandro, largura variável, ilhas) | ✅ |
| Terreno em chunks com streaming, 1 chunk/frame | ✅ |
| Colisão exata contra a mesma função que gerou a malha | ✅ |
| Voo, aceleração, roll, bob | ✅ |
| Tiro, inimigos (navio, helicóptero, caça), destroços | ✅ |
| Combustível como timer, postos de reabastecimento | ✅ |
| Pontes como portão de setor + checkpoint | ✅ |
| Câmera com mola, lag triplo, FOV kick, shake, hitstop | ✅ |
| HUD, vidas, respawn, game over | ✅ |
| Água, iluminação, pós-processamento, áudio | ⛔ fase 2 |

## Decisões que sustentam o resto do projeto

**O mundo é uma função pura de `(x, z)`.** Nada é pré-gerado ou armazenado.
Isso dá terreno infinito sem autoria, colisão exata — a física consulta
exatamente a função que gerou a malha, então não existe deriva entre o que se
vê e o que mata — e determinismo.

**Nada de `Math.random()` na simulação.** Toda aleatoriedade vem de hashes
semeados por índice de chunk. A mesma seed produz o mesmo rio, os mesmos
inimigos e a mesma partida — inclusive o mesmo ruído do screen shake.

**Timestep fixo.** A simulação nunca vê dt variável, então o feel é idêntico a
60 e a 144 Hz. A câmera, ao contrário, roda em tempo de frame com amortecimento
exponencial, que é invariante à taxa.

## Verificação

`npm run shots` sobe o build headless, pilota com o autopilot determinístico e
captura estados fixos do mundo em `shots/`.

O autopilot **não é feature de jogo, é o harness**: piloto roteirizado ⇒ run
reproduzível frame a frame ⇒ screenshot vira artefato diffável em vez de
opinião. Ele também é uma asserção contínua de que o mundo é navegável.

Gates que reprovam o build:

- erro de console ou request falho;
- **morte contra o terreno** — significa que o gerador produziu um canal por
  onde ninguém passaria; é bug, não dificuldade;
- draw calls > 150, triângulos > 400k.

Morte para inimigo ou por tanque vazio é reportada mas **não** reprova: isso é o
bot jogando mal, não um defeito.

Frame time é registrado apenas como tendência. O headless roda em SwiftShader
(rasterização por software), então o número não diz nada sobre hardware real —
um gate de fps de verdade precisa de GPU de verdade e é assunto da fase 4.

## Bugs reais que o harness pegou nesta fase

Registrados porque justificam o custo de ter construído o harness antes da arte:

1. Ilhas estreitavam os dois canais abaixo da envergadura do avião — trecho
   literalmente impossível.
2. O piloto mirava o centro da pista 70 unidades à frente, voando permanentemente
   deslocado ~8 unidades do centro atual. Lookahead deve alimentar velocidade,
   não posição.
3. Lei de controle proporcional chegava ao alvo em velocidade máxima e passava
   por ele em ~6 unidades — quase toda a folga de um canal apertado.
4. A escolha de canal só acontecia quando a ilha já existia — isto é, quando o
   avião já estava em cima dela.
5. Passar por um posto rendia ~13 de combustível de 100. Economia quebrada.
6. Vales no interior afundavam abaixo de `y = 0` e eram inundados pelo plano
   d'água: lagos fantasma a um quilômetro do rio.

## Próximo

Fase 2 é a vertical slice: 60 segundos do jogo em qualidade final — água,
iluminação, pós-processamento, áudio e modelos de verdade. É o slice que se
avalia; se ele for bom, o resto é produção, não descoberta.
