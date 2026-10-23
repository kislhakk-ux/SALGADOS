# Agenda Nane para Android

O aplicativo abre a agenda compartilhada do Render, mantém uma cópia local para uso sem conexão e sincroniza pedidos da loja em segundo plano. Os lembretes de 24 horas e 12 horas são agendados pelo Android.

## Gerar APK instalável

Na pasta `android/`, execute:

```powershell
./gradlew.bat assembleDebug
```

O APK de desenvolvimento é criado em `app/build/outputs/apk/debug/app-debug.apk`. O workflow do GitHub Actions também gera esse arquivo como artefato a cada alteração do projeto Android.

O primeiro acesso ao painel do aplicativo pede a mesma senha privada configurada no Render. O token temporário fica criptografado pelo Android Keystore.
