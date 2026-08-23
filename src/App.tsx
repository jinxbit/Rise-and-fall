import { Analytics } from '@vercel/analytics/react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AdminMapsPage } from './pages/AdminMapsPage'
import { CreateGamePage } from './pages/CreateGamePage'
import { GamePage } from './pages/GamePage'
import { HomePage } from './pages/HomePage'
import { LobbyPage } from './pages/LobbyPage'
import { MapBuilderPage } from './pages/MapBuilderPage'
import { MyGamesPage } from './pages/MyGamesPage'
import { ProfilePage } from './pages/ProfilePage'
import { PublicRoomsPage } from './pages/PublicRoomsPage'
import { UpdateBanner } from './components/UpdateBanner'
import { useAppUpdateAvailable } from './hooks/useAppUpdateAvailable'

function App() {
  const updateAvailable = useAppUpdateAvailable()

  return (
    <BrowserRouter>
      <div className="min-h-screen bg-neutral-950 text-neutral-100">
        {updateAvailable && <UpdateBanner onReload={() => window.location.reload()} />}
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/create" element={<CreateGamePage />} />
          <Route path="/map-builder" element={<MapBuilderPage />} />
          <Route path="/admin/maps" element={<AdminMapsPage />} />
          <Route path="/games" element={<MyGamesPage />} />
          <Route path="/public" element={<PublicRoomsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/lobby/:roomCode" element={<LobbyPage />} />
          <Route path="/game/:roomCode" element={<GamePage />} />
        </Routes>
      </div>
      <Analytics />
    </BrowserRouter>
  )
}

export default App
