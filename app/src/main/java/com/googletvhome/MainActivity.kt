package com.googletvhome

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.googletvhome.presentation.theme.GoogleTVHomeTheme
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            GoogleTVHomeTheme {
                HomeScreenPlaceholder()
            }
        }
    }
}

@Composable
fun HomeScreenPlaceholder() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF121212)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = "🏠 Minha TV",
                fontSize = 48.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White
            )
            Text(
                text = "Hub de entretenimento personalizado",
                fontSize = 20.sp,
                color = Color(0xFFE1E1E1)
            )
            Spacer(modifier = Modifier.height(32.dp))
            Text(
                text = "✅ Arquitetura criada",
                fontSize = 18.sp,
                color = Color(0xFF4CAF50)
            )
            Text(
                text = "✅ Estrutura do projeto configurada",
                fontSize = 18.sp,
                color = Color(0xFF4CAF50)
            )
            Text(
                text = "⏳ Próximo: Implementar UI e APIs",
                fontSize = 18.sp,
                color = Color(0xFFFF9800)
            )
        }
    }
}
